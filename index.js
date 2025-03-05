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
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "Você é um especialista em desenvolvimento de software e revisor de código. Sua tarefa é analisar um diff de código fornecido para: 1. Avaliar a qualidade do código adicionado; 2. Sugerir melhorias relevantes e pertinentes; 3. Identificar e corrigir possíveis erros; 4. Garantir que não sejam introduzidas vulnerabilidades. ### O que você está avaliando O conteúdo enviado é um diff de um merge request consultado na API do GitLab, com as seguintes informações: 1. Nome do arquivo modificado; 2. Código removido (linhas que começam com \"-\"); 3. Código adicionado (linhas que começam com \"+\"). ### O que é esperado Leia o diff do merge request e avalie apenas o **código adicionado** (linhas que começam com \"+\"). A resposta deve ser objetiva, com sugestões relevantes para melhorar o processo e o produto. Siga as seguintes regras abaixo. ### Regras de avaliação 1. Analise exclusivamente as linhas adicionadas (que começam com \"+\"). Use as linhas removidas (que começam com \"-\") apenas como referência para contextualização. 2. Forneça feedbacks claros caso encontre erros de código. 3. Sugira melhorias significativas, considerando desempenho, segurança e qualidade. 4. Utilize as regras do PSR-1 e PSR-12 nas sugestões. 5. Não corrija linhas que não possuem problemas ou não agregam melhorias. 6. Ignore alterações relacionadas apenas a fechamento de tags. 7. Não faça correções de acentuação ou ortografia de palavras, pois no conteúdo do MR, o GIT não coloca as acentuações, exemplo a palavra \"cobrança\" vem como \"cobrana\". 8. Se não houver melhorias ou problemas identificados, aprove o código com uma mensagem destacada ao final. 9. Não comente nada caso o código sugerido é o mesmo de como está no MR. ### Formato esperado da resposta. Se o código exigir alterações, siga o modelo abaixo para apresentar as sugestões. Exemplo de Resposta abaixo: Arquivo: [nome do arquivo revisado] Como está: [Código adicionado que será revisado] Como ficar: [Código com a sugestão de melhoria] Motivo: [Explique claramente o motivo da sugestão de troca.] Se o código estiver aprovado: Finalize a revisão com uma mensagem destacada, como: \"Código aprovado: Nenhum problema encontrado.\" Observações adicionais Não repita sugestões idênticas ao código original (sem melhorias). Certifique-se de que cada sugestão agregue valor ao produto. Mantenha a resposta objetiva e orientada a melhorias."
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
  prompt += `3. Adicione somente o código da sugestão no parâmetro suggestion, qualquer coisa relacionado a explicação deve ficar em explanation\n`;

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
    prompt += `- Não corrija linhas que não possuem problemas ou não agregam melhorias\n`;
    prompt += `- Algumas implementações de app(Class) foram implementadas pois é necessário para a estrutura do projeto\n`;
    prompt += `- Ignore os lugares que utilizem const da Model, pois é uma estrutura para rastrear o uso das colunas no projeto.\n`;
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
 * Parseia as sugestões da resposta da OpenAI com tratamento robusto de erros
 * @param {string|object} content - Conteúdo que pode conter sugestões
 * @returns {Array} Array de objetos de sugestão
 */
function parseSuggestions(content) {
  try {
    // Se já for um objeto, verificar se tem sugestões diretamente
    if (typeof content === 'object' && content !== null) {
      return content.suggestions || [];
    }

    // Garantir que content é uma string
    if (typeof content !== 'string') {
      console.log('Conteúdo não é uma string ou objeto:', typeof content);
      return [];
    }

    // Tentar extrair JSON da resposta
    let jsonContent = content;
    let extractedJson = null;

    // 1. Tentar extrair de blocos de código
    const jsonMatches = [
      content.match(/```json([\s\S]*?)```/),
      content.match(/```([\s\S]*?)```/),
      content.match(/{[\s\S]*"suggestions"[\s\S]*?}/)
    ].filter(Boolean);

    for (const match of jsonMatches) {
      try {
        const extracted = match[1] ? match[1].trim() : match[0].trim();
        // Limpar caracteres que poderiam interferir na análise
        const cleaned = extracted
          .replace(/^```json/, '')
          .replace(/```$/, '')
          .trim();

        // Garantir que é um objeto JSON válido
        if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
          const parsed = JSON.parse(cleaned);
          if (parsed && parsed.suggestions) {
            return parsed.suggestions;
          }
        }
      } catch (e) {
        // Continuar para a próxima tentativa
        console.log(`Falha na extração de bloco de código: ${e.message}`);
      }
    }

    // 2. Tentar encontrar objeto JSON dentro do texto
    try {
      let jsonStr = jsonContent;

      // Se não começa com {, tenta encontrar o objeto JSON
      if (!jsonStr.startsWith('{')) {
        const jsonStart = jsonStr.indexOf('{');
        const jsonEnd = jsonStr.lastIndexOf('}') + 1;

        if (jsonStart !== -1 && jsonEnd > jsonStart) {
          jsonStr = jsonStr.substring(jsonStart, jsonEnd);
        }
      }

      // Verificar se parece um JSON válido antes de tentar analisar
      if (jsonStr.startsWith('{') && jsonStr.endsWith('}')) {
        try {
          // Remover caracteres problemáticos
          const cleanedJson = jsonStr
            .replace(/\r?\n/g, ' ')               // Substituir quebras de linha por espaços
            .replace(/[\u0000-\u001F]+/g, ' ')    // Remover caracteres de controle
            .replace(/\s+/g, ' ')                 // Normalizar espaços
            .trim();

          const parsed = JSON.parse(cleanedJson);
          if (parsed && parsed.suggestions) {
            return parsed.suggestions;
          }
        } catch (jsonError) {
          console.log('Erro ao analisar JSON limpo:', jsonError.message);

          // Tentar método mais agressivo de limpeza
          try {
            // Normalizar aspas e chaves
            let normalizedJson = jsonStr
              .replace(/"/g, '"')                 // Normalizar aspas
              .replace(/"/g, '"')                 // Normalizar aspas curvas
              .replace(/'/g, "'")                 // Normalizar apóstrofos
              .replace(/\r?\n\s*(\d+)\s*/, '\n')  // Remover números de linha
              .replace(/,\s*]/g, ']')             // Remover vírgulas antes de fechamento de arrays
              .replace(/,\s*}/g, '}');            // Remover vírgulas antes de fechamento de objetos

            const parsed = JSON.parse(normalizedJson);
            if (parsed && parsed.suggestions) {
              return parsed.suggestions;
            }
          } catch (deepCleanError) {
            console.log('Erro ao analisar JSON normalizado:', deepCleanError.message);
          }
        }
      }
    } catch (outerError) {
      console.log('Falha geral na extração de JSON:', outerError.message);
    }

    // 3. Se todas as tentativas de análise JSON falharem, tentar método manual
    console.log('Todas as tentativas de análise JSON falharam. Usando método manual.');
    return parseManualSuggestions(content);
  } catch (error) {
    console.error('Erro crítico ao analisar sugestões:', error.message);
    console.log('Conteúdo problemático:', content.substring(0, 200) + '...');
    return parseManualSuggestions(content);
  }
}

/**
 * Método alternativo para extrair sugestões quando a análise JSON falha
 * @param {string} content - Conteúdo textual contendo sugestões
 * @returns {Array} Array de objetos de sugestão
 */
function parseManualSuggestions(content) {
  if (typeof content !== 'string') {
    return [];
  }

  const suggestions = [];

  try {
    // Método 1: Extração baseada em estrutura JSON
    if (content.includes('"lineNumber"') && content.includes('"suggestion"')) {
      // Limpar possíveis problemas de formatação
      const cleanedContent = content
        .replace(/\r?\n\s*(\d+)\s*/, '\n')  // Remover números de linha
        .replace(/,\s*]/g, ']')            // Remover vírgulas antes de fechamento de arrays
        .replace(/,\s*}/g, '}');           // Remover vírgulas antes de fechamento de objetos

      // Extrair objetos de sugestão usando regex
      const suggestionPattern = /{[^{]*?"lineNumber"\s*:\s*(\d+)[^{]*?"suggestion"\s*:\s*"([^"]*)"[^{]*?"explanation"\s*:\s*"([^"]*)"/g;
      let match;

      while ((match = suggestionPattern.exec(cleanedContent)) !== null) {
        suggestions.push({
          lineNumber: parseInt(match[1], 10),
          suggestion: match[2].replace(/\\"/g, '"'),
          explanation: match[3].replace(/\\"/g, '"')
        });
      }

      if (suggestions.length > 0) {
        return suggestions;
      }

      // Se o regex não encontrou sugestões, tentar linha por linha
      const lines = cleanedContent.split('\n');
      let currentSuggestion = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Verificar se é o início de uma sugestão
        const lineNumberMatch = line.match(/"lineNumber"\s*:\s*(\d+)/);
        if (lineNumberMatch) {
          // Finalizar sugestão anterior se existir
          if (currentSuggestion && currentSuggestion.lineNumber && currentSuggestion.suggestion) {
            suggestions.push(currentSuggestion);
          }

          // Iniciar nova sugestão
          currentSuggestion = {
            lineNumber: parseInt(lineNumberMatch[1], 10),
            suggestion: '',
            explanation: ''
          };

          // Verificar se a linha também contém a sugestão
          const suggestionMatch = line.match(/"suggestion"\s*:\s*"([^"]*)"/);
          if (suggestionMatch) {
            currentSuggestion.suggestion = suggestionMatch[1].replace(/\\"/g, '"');
          }

          // Verificar se a linha tem explicação
          const explanationMatch = line.match(/"explanation"\s*:\s*"([^"]*)"/);
          if (explanationMatch) {
            currentSuggestion.explanation = explanationMatch[1].replace(/\\"/g, '"');
          }
        }
        // Se não é o início de uma sugestão, verificar se contém sugestão ou explicação
        else if (currentSuggestion) {
          if (!currentSuggestion.suggestion) {
            const suggestionMatch = line.match(/"suggestion"\s*:\s*"([^"]*)"/);
            if (suggestionMatch) {
              currentSuggestion.suggestion = suggestionMatch[1].replace(/\\"/g, '"');
            }
          }

          if (!currentSuggestion.explanation) {
            const explanationMatch = line.match(/"explanation"\s*:\s*"([^"]*)"/);
            if (explanationMatch) {
              currentSuggestion.explanation = explanationMatch[1].replace(/\\"/g, '"');
            }
          }
        }
      }

      // Adicionar a última sugestão se existir
      if (currentSuggestion && currentSuggestion.lineNumber && currentSuggestion.suggestion) {
        suggestions.push(currentSuggestion);
      }

      if (suggestions.length > 0) {
        return suggestions;
      }
    }

    // Método 2: Extração de texto em linguagem natural
    const lines = content.split('\n');
    let currentLine = null;
    let currentSuggestion = '';
    let currentExplanation = '';

    for (const line of lines) {
      // Detectar número de linha - considerar mais formatos
      if (line.match(/(?:Linha|Line|L\.|#)\s*(\d+)/i)) {
        // Salvar sugestão anterior se existir
        if (currentLine !== null && currentSuggestion) {
          suggestions.push({
            lineNumber: currentLine,
            suggestion: currentSuggestion.trim(),
            explanation: currentExplanation.trim() || 'Melhoria sugerida.'
          });
        }

        // Iniciar nova sugestão
        const match = line.match(/(?:Linha|Line|L\.|#)\s*(\d+)/i);
        currentLine = match ? parseInt(match[1], 10) : null;
        currentSuggestion = line.replace(match[0], '').trim();
        currentExplanation = '';
      } else if (line.match(/(?:Sugestão|Suggestion|Sugestao)[:|-]/i)) {
        currentSuggestion = line.split(/[:|-]/).slice(1).join(':').trim();
      } else if (line.match(/(?:Explicação|Explanation|Explicacao|Razão|Reason)[:|-]/i)) {
        currentExplanation = line.split(/[:|-]/).slice(1).join(':').trim();
      } else if (currentLine !== null && !currentSuggestion && line.trim()) {
        // Se não encontramos uma sugestão explícita, considere que a próxima linha não vazia é a sugestão
        currentSuggestion = line.trim();
      } else if (currentLine !== null && currentSuggestion && !currentExplanation && line.trim()) {
        // Se já temos sugestão mas não explicação, próxima linha não vazia é explicação
        currentExplanation = line.trim();
      }
    }

    // Adicionar a última sugestão
    if (currentLine !== null && currentSuggestion) {
      suggestions.push({
        lineNumber: currentLine,
        suggestion: currentSuggestion.trim(),
        explanation: currentExplanation.trim() || 'Melhoria sugerida.'
      });
    }
  } catch (error) {
    console.error('Erro no processamento manual de sugestões:', error.message);
  }

  return suggestions;
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