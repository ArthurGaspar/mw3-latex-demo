// Tiny EN/PT dictionary. English strings are the keys; a missing Portuguese entry
// falls back to the English text, so an untranslated string never renders blank.
//
// Static markup opts in with attributes whose value is the English key:
//   data-i18n             → textContent
//   data-i18n-title       → title
//   data-i18n-placeholder → placeholder
(function () {
    'use strict';

    const LANG_KEY = 'latex-studio:lang';

    const PT = {
        // Header
        'In-browser LaTeX editor — pdfTeX compiled to WebAssembly, no server.':
            'Editor LaTeX no navegador — pdfTeX compilado para WebAssembly, sem servidor.',
        'Switch language': 'Mudar idioma',
        'Toggle dark mode': 'Alternar modo escuro',

        // Toolbar
        'Document name': 'Nome do documento',
        'Save': 'Salvar',
        'New': 'Novo',
        'Delete': 'Excluir',
        '+ Template…': '+ Modelo…',
        'Text formatting': 'Formatação de texto',
        'Bold': 'Negrito',
        'Italic': 'Itálico',
        'Em dash': 'Travessão',
        'Link (\\href)': 'Link (\\href)',
        'Select the URL before clicking': 'Selecione a URL antes de clicar',
        'Headings': 'Títulos',
        'Section': 'Seção',
        'Subsection': 'Subseção',
        'Subsubsection': 'Subsubseção',
        'Lists': 'Listas',
        'List (itemize)': 'Lista (itemize)',
        'Numbered list (enumerate)': 'Lista numerada (enumerate)',
        'Exercise choices': 'Alternativas de exercício',
        'Solution steps': 'Etapas de resolução',
        'Paragraph and alignment': 'Parágrafo e alinhamento',
        'Line break': 'Quebra de linha',
        'Blank-line paragraph': 'Parágrafo com linha em branco',
        'Indent (\\indent)': 'Recuo (\\indent)',
        'Center': 'Centralizar',
        'Align right': 'Alinhar à direita',
        'Boxes (tcolorbox)': 'Caixas (tcolorbox)',
        'Definition': 'Definição',
        'Note': 'Observação',
        'Example': 'Exemplo',
        'Text': 'Texto',
        'Generic': 'Genérica',
        'Compile (Ctrl+Enter)': 'Compilar (Ctrl+Enter)',
        'Download PDF': 'Baixar PDF',
        'Sync editor and PDF scrolling': 'Sincronizar rolagem entre editor e PDF',
        'Toggle focus mode (Esc to exit)': 'Alternar modo foco (Esc para sair)',
        '⛶ Focus': '⛶ Foco',
        '⛶ Exit': '⛶ Sair',

        // Search
        'Search the source…': 'Buscar no código…',
        'Previous (Shift+Enter)': 'Anterior (Shift+Enter)',
        'Next (Enter)': 'Próximo (Enter)',
        'Close (Esc)': 'Fechar (Esc)',

        // Preview
        'Compile to see the PDF': 'Compile para ver o PDF',

        // Templates
        'Blank': 'Em branco',
        'Lecture notes': 'Notas de aula',
        'Article': 'Artigo',
        'New Document': 'Novo Documento',
        'New Lecture Notes': 'Novas Notas de Aula',
        'New Article': 'Novo Artigo',
        'Untitled': 'Sem título',

        // Status
        'Loading engine (~2 MB)…': 'Carregando engine (~2 MB)…',
        'Engine ready': 'Engine pronto',
        'Engine failed to load': 'Falha ao carregar engine',
        'Draft — not saved': 'Rascunho — não salvo',
        'Saved': 'Salvo',
        'Compiling…': 'Compilando…',
        'Compiled successfully': 'Compilado com sucesso',
        'View kept — recompile to refresh': 'Visualização mantida — recompile para atualizar',
        'Could not display the PDF': 'Falha ao exibir o PDF',
        'Compile error — see the log': 'Erro de compilação — veja o log',
        '(no log)': '(sem log)',
        'Engine error: {error} — try compiling again': 'Erro no engine: {error} — tente compilar de novo',
        'Compile first': 'Compile primeiro',
        'No saved documents': 'Não há documentos salvos',
        'Cannot delete the only document': 'Não é possível excluir o único documento',
        'Delete "{name}"? This cannot be undone.': 'Excluir "{name}"? Isso não pode ser desfeito.',
        '"{style}" is defined in the Lecture notes preamble — copy it over if this document lacks it':
            '"{style}" é definido no preâmbulo das Notas de aula — copie-o se este documento não o tiver',
        'The current PDF has annotations (highlights, drawings, text…) that will be lost when the preview refreshes.\n\nTo keep them, cancel and download the PDF with the viewer\'s save button.\n\nReplace anyway?':
            'O PDF atual tem anotações (destaques, desenhos, texto…) que serão perdidas ao atualizar a visualização.\n\nPara guardá-las, cancele e baixe o PDF pelo botão de salvar do visualizador.\n\nSubstituir mesmo assim?',
    };

    const DICTS = { pt: PT };
    const listeners = [];

    function readLang() {
        try {
            const saved = localStorage.getItem(LANG_KEY);
            if (saved === 'en' || saved === 'pt') return saved;
        } catch {}
        return (navigator.language || '').toLowerCase().startsWith('pt') ? 'pt' : 'en';
    }

    let lang = readLang();

    function t(key, vars) {
        let s = (DICTS[lang] && DICTS[lang][key]) || key;
        if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
        return s;
    }

    function apply(root) {
        const scope = root || document;
        scope.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
        scope.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
        scope.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
        document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
    }

    function setLang(next) {
        if (next !== 'en' && next !== 'pt') return;
        lang = next;
        try { localStorage.setItem(LANG_KEY, next); } catch {}
        apply();
        listeners.forEach(fn => fn(lang));
    }

    window.Studio = window.Studio || {};
    window.Studio.i18n = {
        t,
        apply,
        setLang,
        get lang() { return lang; },
        onChange(fn) { listeners.push(fn); },
    };
})();
