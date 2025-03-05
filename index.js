const core = require('@actions/core');
const github = require('@actions/github');
const { OpenAI } = require('openai');

async function run() {
  try {
    // Obter token do GitHub e da OpenAI das variáveis de ambiente
    const githubToken = core.getInput('github-token');
    const openaiApiKey = core.getInput('openai-api-key');
    const octokit = github.getOctokit(githubToken);
    const openai = new OpenAI({
      apiKey: openaiApiKey,
    });

    // Contexto do evento do GitHub
    const context = github.context;
    const { owner, repo } = context.repo;
    const pullRequestNumber = context.payload.pull_request?.number;

    if (!pullRequestNumber) {
      core.setFailed('Este action só funciona em eventos de pull request.');
      return;
    }

    // Obter os arquivos alterados no PR
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullRequestNumber,
    });

    // Filtrar apenas arquivos no diretório app/Api
    const apiFiles = files.filter(file => file.filename.startsWith('app/Api'));

    if (apiFiles.length === 0) {
      console.log('Nenhuma alteração encontrada no diretório app/Api.');
      return;
    }

    // Para cada arquivo, obter o conteúdo e as mudanças
    for (const file of apiFiles) {
      console.log(`Analisando arquivo: ${file.filename}`);

      // Obter as linhas modificadas (patch)
      const patch = file.patch;
      if (!patch) continue;

      // Extrair as linhas adicionadas ou modificadas do patch
      const changedLines = extractChangedLines(patch);
      if (changedLines.length === 0) continue;

      // Preparar prompt para a OpenAI
      const prompt = createPrompt(file.filename, changedLines);

      // Chamar a OpenAI para análise de código
      const response = await openai.chat.completions.create({
        model: "gpt-4-turbo",
        messages: [
          {
            role: "system",
            content: "Você é um revisor de código especialista em Laravel 10 e PHP 8.3. Seu trabalho é analisar código, identificar problemas e sugerir melhorias. Forneça análises diretas e específicas para cada trecho de código, com foco em boas práticas, segurança e performance. Na sugestão, inclua APENAS o código corrigido, sem explicações ou comentários dentro do código. A explicação deve ser fornecida separadamente."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.3,
      });

      // Processar as sugestões da OpenAI
      const suggestions = parseSuggestions(response.choices[0].message.content);

      // Adicionar as sugestões como comentários no PR
      await addCommentsToPR(octokit, owner, repo, pullRequestNumber, file, suggestions, commitId);
    }

    console.log('Revisão de código completa!');
  } catch (error) {
    core.setFailed(`Action falhou: ${error.message}`);
  }
}

/**
 * Extrai as linhas modificadas/adicionadas do patch
 */
function extractChangedLines(patch) {
  const lines = patch.split('\n');
  const changedLines = [];
  let currentLine = 0;

  for (const line of lines) {
    // Linhas que começam com '@@' indicam a posição no arquivo
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        currentLine = parseInt(match[1], 10) - 1;
      }
      continue;
    }

    // Incrementar a linha atual
    currentLine++;

    // Linhas adicionadas (começam com '+')
    if (line.startsWith('+') && !line.startsWith('+++')) {
      changedLines.push({
        lineNumber: currentLine,
        content: line.substring(1) // Remover o '+'
      });
    }
  }

  return changedLines;
}

/**
 * Cria o prompt para a OpenAI
 */
function createPrompt(filename, changedLines) {
  const fileExtension = filename.split('.').pop();
  const isPhpFile = fileExtension === 'php';

  let prompt = `Analise as seguintes alterações no arquivo ${filename} que é parte de um projeto Laravel 10 com PHP 8.3.\n\n`;

  for (const line of changedLines) {
    prompt += `Linha ${line.lineNumber}: ${line.content}\n`;
  }

  prompt += `\nPara cada linha ou bloco de código, forneça:\n`;
  prompt += `1. Uma análise crítica do código\n`;
  prompt += `2. Sugestões específicas de melhoria, se aplicável\n`;
  prompt += `3. Explicação breve do motivo da alteração sugerida\n`;

  if (isPhpFile) {
    prompt += `\nConsidere especificamente boas práticas do Laravel 10 e recursos do PHP 8.3 como:\n`;
    prompt += `- Uso de tipos de retorno e tipos de parâmetros\n`;
    prompt += `- Recursos de PHP 8.3 como readonly classes, typed class constants, etc.\n`;
    prompt += `- Padrões do Laravel como Resource Controllers, Form Requests, etc.\n`;
    prompt += `- Potenciais problemas de segurança como SQL injection, XSS, etc.\n`;
    prompt += `- Otimizações de performance\n`;
    prompt += `- Utilize Regras do PSR-1 e PSR-12 nas sugestões\n`;
    prompt += `- Ignore alterações relacionadas apenas a fechamento de tags\n`;
    prompt += `- Não comente nada caso o código sugerido é o mesmo de como está no PR\n`;
  }

  prompt += `\nFormate suas respostas como JSON com o seguinte formato:
{
  "suggestions": [
    {
      "lineNumber": 123,
      "suggestion": "public function exemplo(): string {",
      "explanation": "Breve explicação do motivo"
    }
  ]
}

IMPORTANTE: O campo "suggestion" deve conter APENAS o código válido da linha corrigida, sem comentários ou explicações. A aplicação vai falhar se incluir qualquer coisa além do código em si.`;

  return prompt;
}

/**
 * Parseia as sugestões da resposta da OpenAI
 */
function parseSuggestions(content) {
  try {
    // Tentar extrair JSON da resposta
    const jsonMatch = content.match(/```json([\s\S]*?)```/) ||
      content.match(/{[\s\S]*?}/);

    const jsonContent = jsonMatch
      ? jsonMatch[1] || jsonMatch[0]
      : content;

    const parsed = JSON.parse(jsonContent);
    return parsed.suggestions || [];
  } catch (error) {
    console.error('Erro ao analisar sugestões:', error);
    console.log('Conteúdo recebido:', content);

    // Tentar um método alternativo para extrair sugestões
    const suggestions = [];
    const lines = content.split('\n');

    let currentLine = null;
    let currentSuggestion = null;
    let currentExplanation = '';

    for (const line of lines) {
      if (line.startsWith('Linha ') && line.includes(':')) {
        // Salvar sugestão anterior se existir
        if (currentLine && currentSuggestion) {
          suggestions.push({
            lineNumber: currentLine,
            suggestion: currentSuggestion,
            explanation: currentExplanation.trim()
          });
        }

        // Iniciar nova sugestão
        const match = line.match(/Linha (\d+):/);
        currentLine = match ? parseInt(match[1], 10) : null;
        currentSuggestion = null;
        currentExplanation = '';
      } else if (line.includes('Sugestão:') || line.includes('Suggestion:')) {
        currentSuggestion = line.split(':').slice(1).join(':').trim();
      } else if (currentLine && !currentExplanation && line.trim()) {
        currentExplanation = line;
      } else if (currentExplanation && line.trim()) {
        currentExplanation += ' ' + line.trim();
      }
    }

    // Adicionar a última sugestão
    if (currentLine && currentSuggestion) {
      suggestions.push({
        lineNumber: currentLine,
        suggestion: currentSuggestion,
        explanation: currentExplanation.trim()
      });
    }

    return suggestions;
  }
}

/**
 * Adiciona comentários ao PR
 */
async function addCommentsToPR(octokit, owner, repo, pullNumber, file, suggestions, commitId) {
  try {
    // Obter o commit mais recente do PR, se não tiver sido passado
    if (!commitId) {
      const { data: pullRequest } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });

      commitId = pullRequest.head.sha;
    }

    // Para cada sugestão, criar um comentário de revisão
    for (const suggestion of suggestions) {
      console.log(`Adicionando comentário para a linha ${suggestion.lineNumber} no arquivo ${file.filename}`);

      // Formatar a sugestão para conter apenas o código, sem explicação dentro do bloco sugestão
      const body = `**Sugestão do Code Reviewer:**

\`\`\`suggestion
${suggestion.suggestion}
\`\`\`

${suggestion.explanation}`;

      await octokit.rest.pulls.createReviewComment({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: commitId,
        path: file.filename,
        body: body,
        line: suggestion.lineNumber,
      });
    }
  } catch (error) {
    console.error('Erro ao adicionar comentários:', error);
  }
}

run();