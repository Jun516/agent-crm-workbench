import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
});
const app = new pg.Pool({
  connectionString: `postgresql://ontology_schema_user:synthetic@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
});

beforeAll(() => {
  // The migration executor is a non-superuser with schema grant authority.
  // No membership in ontology_reader is granted by the fixture.
  sql(`create role ontology_schema_user login password 'synthetic' createrole;
    grant usage on schema public, auth to ontology_schema_user with grant option;
    grant execute on function auth.uid(), auth.jwt() to ontology_schema_user with grant option;
    grant execute on function public.fn_user_org_ids(), public.fn_user_role_in_org(uuid),
      public.fn_is_platform_admin(), public.fn_can_view_lead(uuid,uuid),
      public.fn_role_at_least(uuid,text) to ontology_schema_user with grant option;
    grant select (id, organization_id, status, value_cents, currency, pipeline_id, owner_user_id)
      on public.crm_leads to ontology_schema_user with grant option;
    grant select (id, organization_id, lead_id, contact_id, status, due_date)
      on public.crm_tasks to ontology_schema_user with grant option;
    grant select (id, organization_id) on public.contacts to ontology_schema_user with grant option;
    grant select (organization_id, lead_id, type, performed_at)
      on public.crm_lead_activities to ontology_schema_user with grant option;
    grant select (id, settings) on public.organizations to ontology_schema_user with grant option;`);
});

afterAll(async () => {
  await app.end();
  await pool.end();
});

describe("ontology migration with a non-superuser app/schema connection", () => {
  it("requires real grant authority and safely replays an existing membership", async () => {
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    const start = baseline.indexOf("do $ontology_role$", baseline.indexOf("-- Narrow, non-login role for ontology templates."));
    const end = baseline.indexOf("$ontology_role$;", start) + "$ontology_role$;".length;
    expect(start).toBeGreaterThan(0);
    const block = baseline.slice(start, end);
    const migration = readFileSync("supabase/migrations/20261114130000_0414_ontology_role_set_compat.sql", "utf8");
    const version = Number((await pool.query("show server_version_num")).rows[0].server_version_num);

    if (version >= 160000) {
      await expect(app.query(block)).rejects.toMatchObject({ code: "42501" });
      await pool.query("grant ontology_reader to ontology_schema_user");
    } else {
      await app.query(block);
    }
    await app.query(block);
    await app.query(migration);
    await app.query("begin; set local role ontology_reader; rollback");
    const check = readFileSync("supabase/ontology-role-check.sql", "utf8");
    expect(sql(`set session authorization ontology_schema_user;\n${check}`).split("\n")).toContain("ok");

    if (version >= 160000) {
      await pool.query("revoke ontology_reader from ontology_schema_user");
      await pool.query("grant ontology_reader to ontology_schema_user with set false");
      const membership = await pool.query("select pg_has_role('ontology_schema_user', 'ontology_reader', 'MEMBER') as member, pg_has_role('ontology_schema_user', 'ontology_reader', 'SET') as can_set");
      expect(membership.rows[0]).toEqual({ member: true, can_set: false });
      await expect(app.query(block)).rejects.toMatchObject({ code: "42501" });
      await pool.query("grant ontology_reader to ontology_schema_user with set true");
      await app.query(migration);
    }

    // Exercise the actual bootstrap block for a role created by the schema user.
    const fresh = block.replaceAll("ontology_reader", "ontology_reader_fresh_probe");
    await app.query(fresh);
    await app.query("begin; set local role ontology_reader_fresh_probe; rollback");
  });

  it("provisions the actual app connection through the migration and kit entry points", async () => {
    await pool.query("create role ontology_install_app login password 'synthetic'");
    const dir = mkdtempSync(join(tmpdir(), "ontology-psql-"));
    const appUrl = "postgresql://ontology_install_app:synthetic@127.0.0.1:5432/postgres";
    const adminUrl = "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
    const env = { ...process.env, SUPABASE_DB_URL: appUrl, SUPABASE_DB_ADMIN_URL: adminUrl };
    try {
      writeFileSync(join(dir, "psql"), '#!/bin/bash\nargs=()\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = -f ]; then file=$2; args+=( -f - ); shift 2; else args+=( "$1" ); shift; fi\ndone\nif [ -n "${file:-}" ]; then exec docker exec -i "$TEST_DB_CONTAINER" psql "${args[@]}" < "$file"; else exec docker exec -i "$TEST_DB_CONTAINER" psql "${args[@]}"; fi\n', { mode: 0o755 });
      execFileSync("bash", ["scripts/db-migrate.sh"], { env: { ...env, PATH: `${dir}:${process.env.PATH}` }, stdio: "pipe", timeout: 120000 });
      const helper = `docker() { shift 2; if [ "$1" = -i ]; then shift; fi; shift; command docker exec -i "$TEST_DB_CONTAINER" "$@"; }
source hostgator-setup-kit/_common.sh
provisionar_leitura_ontology`;
      // With an already usable membership, even an admin connection lacking ADMIN OPTION succeeds.
      execFileSync("bash", ["-c", helper], { env: { ...env, SUPABASE_DB_ADMIN_URL: appUrl }, stdio: "pipe" });
      await pool.query("revoke ontology_reader from ontology_install_app");
      expect(() => execFileSync("bash", ["-c", helper], { env: { ...env, SUPABASE_DB_ADMIN_URL: appUrl }, stdio: "pipe" })).toThrow();
      execFileSync("bash", ["-c", helper], { env, stdio: "pipe" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180000);

});
