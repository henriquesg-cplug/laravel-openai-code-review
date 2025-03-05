# Laravel Code Review com OpenAI

Esta GitHub Action realiza automaticamente code reviews em Pull Requests, focando especificamente em código Laravel 10 e PHP 8.3 no diretório `app/Api`.

## Características

- Analisa apenas as linhas modificadas em arquivos no caminho `app/Api`
- Cria comentários de sugestão diretamente nas linhas relevantes
- Realiza análise especializada baseada em Laravel 10 e PHP 8.3
- Fornece explicações breves para cada sugestão de alteração

## Configuração

### 1. Adicione a Secret da OpenAI

No seu repositório GitHub, adicione a secret `OPENAI_API_KEY` com sua chave de API da OpenAI:

1. Vá para Settings > Secrets and variables > Actions
2. Clique em "New repository secret"
3. Adicione `OPENAI_API_KEY` como nome e sua chave de API como valor

### 2. Crie o Workflow

Crie um arquivo `.github/workflows/code-review.yml` no seu repositório com o seguinte conteúdo:

```yaml
name: Code Review com IA

on:
  pull_request:
    types: [opened, synchronize]
    paths:
      - 'app/Api/**'

jobs:
  code-review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0
      
      - name: Executar Code Review com IA
        uses: seu-usuario/laravel-openai-code-review@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

Substitua `seu-usuario/laravel-openai-code-review@main` pelo caminho correto da sua action.

## Desenvolvimento Local

Para desenvolver e testar localmente:

1. Clone este repositório
2. Instale as dependências:
   ```bash
   npm install
   ```
3. Faça suas alterações no arquivo `index.js`
4. Compile para distribuição:
   ```bash
   npm run build
   ```

## Como Funciona

1. A action é acionada quando um PR é aberto ou atualizado
2. Ela identifica arquivos modificados apenas no diretório `app/Api`
3. Para cada arquivo, extrai as linhas que foram adicionadas ou modificadas
4. Envia estas linhas para a API da OpenAI para análise por um assistente especializado em Laravel 10 e PHP 8.3
5. Parseia as sugestões recebidas
6. Adiciona comentários de sugestão diretamente no PR, na linha específica que precisa de atenção

## Licença

MIT
