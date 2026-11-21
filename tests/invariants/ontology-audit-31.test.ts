import { beforeAll, describe, expect, it } from "vitest";
import {
  GOV_AGENT_A,
  GOV_CONTACT_1,
  GOV_ORG,
  GOV_PIPELINE,
  GOV_STAGE,
  countAs,
  seedGov,
  sql,
} from "./gov-helpers";

const A = "a3100000-0000-4000-8000-000000000001";
const B = "a3100000-0000-4000-8000-000000000002";
const C = "a3100000-0000-4000-8000-000000000003";
const OTHER = "a3100000-0000-4000-8000-000000000004";

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id)
      values ('${A}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Audit A', '${GOV_CONTACT_1}'),
             ('${B}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Audit B', '${GOV_CONTACT_1}'),
             ('${C}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Audit sem contato', null);
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${OTHER}', 'ontology-audit-31', 'Audit', 'Audit');
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
      select '${OTHER}', p.id, s.id, 'Audit outro tenant'
      from public.crm_pipelines p join public.crm_stages s on s.pipeline_id = p.id
      where p.organization_id = '${OTHER}' and not s.is_won and not s.is_lost limit 1;
  `);
});

describe("audit #31: fatos do baseline, não um resolvedor semântico", () => {
  it("contato pode ter dois negócios; não se colapsa a relação", () => {
    expect(
      sql(
        `select count(*) from public.crm_leads where id in ('${A}', '${B}') and contact_id = '${GOV_CONTACT_1}'`,
      ),
    ).toBe("2");
  });
  it("negócio sem contato persiste e campos ausentes continuam nulos", () => {
    expect(
      sql(
        `select (contact_id is null and value_cents is null and last_activity_at is null)::text from public.crm_leads where id = '${C}'`,
      ),
    ).toBe("true");
  });
  it("a sessão autenticada não lê negócios de organização sem membership", () => {
    expect(sql(`select count(*) from public.crm_leads where organization_id = '${OTHER}'`)).toBe(
      "1",
    );
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.crm_leads where organization_id = '${OTHER}';`,
      ),
    ).toBe(0);
    expect(countAs(GOV_AGENT_A, `select count(*) from public.crm_leads where id = '${C}';`)).toBe(
      1,
    );
  });
});
