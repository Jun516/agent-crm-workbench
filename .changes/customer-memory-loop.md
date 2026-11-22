---
impacto: capacidade_nova
secao: adicionado
titulo: Memória de cliente com validade e revisão explícitas
---

A memória confirmada continua no SQL e pode declarar validade, trava e revisão.
Pedidos temporários vencidos deixam de entrar no contexto; restrições válidas
travadas são buscadas independentemente do ranking opcional do Mem0. A substituição
preserva o vínculo com a memória anterior e a limpeza remota continua auditável.

Conversas encerradas e tarefas concluídas podem gerar sugestões com trechos de
evidência, sem confirmá-las automaticamente. O relatório e o contato oferecem
confirmação, reescrita e rejeição com prazo; responsáveis controlam travas e revisão,
e gestores arbitram conflitos. A manutenção noturna deduplica candidatos e trata
validade sem sobrescrever o conteúdo confirmado travado.

Antes de cada chamada, o agente recebe contexto confirmado atual, separado dos fatos
comerciais e do atendimento. Relatórios e rascunhos mostram recibos de leitura e
permitem corrigir o uso: a versão correspondente entra em revisão humana, sem
reescrever a preferência nem remover a trava.

Gestores veem taxas de confirmação/rejeição, tempo de confirmação, sugestões
antigas, espera de conflitos e correções por relatório/rascunho. Filas e estados
permitem carregar páginas sem expor fontes privadas. A avaliação usa recibos SQL
para conferir as regras de memória e existe uma regressão determinística
`pnpm --silent eval:customer-memory` para mudanças da estratégia de recall.

A janela local considera a relevância para a tarefa antes do corte por quantidade,
para que uma preferência antiga não seja expulsa por registros novos sem relação.
O limite do contexto e a busca independente das restrições travadas são mantidos.

Resultados semânticos podem reencontrar uma preferência fora da janela lexical,
sempre relendo identidade, conteúdo e validade no SQL; texto remoto não vira fato.

A revisão noturna continua por páginas persistidas, inclusive entre páginas, sem
aumentar cada chamada além de 100 memórias. Mudanças depois dos primeiros 101
registros também acionam uma nova revisão; fatos confirmados não são reescritos.

O relatório e o contato mostram o estado real da organização de memória, inclusive
quando falta um modelo. Responsáveis e gestores podem repetir uma tarefa que falhou,
com autorização atual, versão e idempotência, sem expor fontes privadas ou erros brutos.
Repetir a tarefa mantém a evidência e não confirma sugestões automaticamente.

A repetição funciona também em instalação HTTP sem `crypto.randomUUID`, usando
o gerador compatível do CRM e preservando a mesma chave quando o resultado é incerto.

O planejamento do próximo contato também recarrega as restrições confirmadas no SQL,
preservando a conversa de origem e recusando atendimento vencido antes de chamar o modelo.
