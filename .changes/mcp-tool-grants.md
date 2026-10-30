---
impacto: nada_mudou
secao: corrigido
titulo: Tokens de execução limitados às ferramentas da tarefa
---

Os tokens temporários emitidos por uma execução agora registram os nomes exatos das
ferramentas habilitadas. Tanto o servidor MCP quanto a ponte interna verificam essa
lista, além de papel e escopo de leitura ou escrita. Uma lista vazia não libera o
catálogo inteiro. Tokens antigos sem essa convenção mantêm seus escopos anteriores.
O servidor anuncia apenas ferramentas autorizadas e repete a verificação ao chamar.
