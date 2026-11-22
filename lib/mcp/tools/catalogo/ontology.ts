import { declararTools } from "./tipos";

// Keep semantic discovery in the organization bundle. The default sales
// bundle already reserves the remaining capacity for existing sales tools.
export const TOOLS_ONTOLOGY = declararTools([
  {
    name: "ontology_search_terms",
    category: "read",
    rotulo: "Buscar conceitos de negócio",
    explicacao: "Encontra conceitos publicados e mostra o estado das definições disponíveis.",
    oQueToca: "Conceitos de negócio",
    risco: "seguro",
    pacotes: ["organizar"],
  },
  {
    name: "ontology_check_answerable",
    category: "read",
    rotulo: "Verificar uma pergunta",
    explicacao: "Verifica se uma pergunta tem definições e fontes suficientes para ser consultada.",
    oQueToca: "Conceitos de negócio",
    risco: "seguro",
    pacotes: ["organizar"],
  },
  {
    name: "ontology_describe_action", category: "read",
    rotulo: "Descrever uma ação", explicacao: "Mostra condições e limites de uma capacidade antes de propor uma ação.",
    oQueToca: "Capacidades do CRM", risco: "seguro", pacotes: ["organizar"],
  },
  {
    name: "ontology_describe_outcome", category: "read",
    rotulo: "Descrever evidências da missão", explicacao: "Mostra quais sinais podem ser conferidos e os limites de uma missão.",
    oQueToca: "Missão comercial", risco: "seguro", pacotes: ["organizar"],
  },
  {
    name: "ontology_query",
    category: "read",
    rotulo: "Consultar dados com evidência",
    explicacao: "Consulta dados permitidos e apresenta os critérios e fontes usados na resposta.",
    oQueToca: "Funil de vendas",
    risco: "seguro",
    pacotes: ["organizar"],
  },
]);
