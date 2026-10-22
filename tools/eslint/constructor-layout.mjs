/** Constructor-only layout rule. Preserves parameter expressions and comments. */
export default {
  meta: {
    type: 'layout',
    docs: { description: 'Fit constructor signatures to the configured width, preserving comments, literals and body layout.' },
    fixable: 'whitespace',
    schema: [{
      type: 'object',
      properties: { maxLength: { type: 'integer', minimum: 1 } },
      additionalProperties: false,
    }],
    messages: {
      singleLine: 'Keep constructor signatures on one line when they fit within {{maxLength}} characters.',
      parameter: 'Put each constructor parameter on its own line, indented by two spaces.',
      closingParen: 'Put the constructor closing parenthesis on its own line.',
      openingBrace: 'Use one space between the closing parenthesis and the opening brace.',
      trailingComma: 'Do not put a trailing comma after the last constructor parameter.',
      emptyBody: 'Keep an empty constructor body as {} on the closing-parenthesis line.',
    },
  },
  create(context) {
    const source = context.sourceCode;
    const maxLength = context.options[0]?.maxLength ?? 120;
    function newlineBefore(token, indent, messageId) {
      const previous = source.getTokenBefore(token, { includeComments: true });
      if (!previous) return;
      const gap = [previous.range[1], token.range[0]];
      const expected = `\n${indent}`;
      const actual = source.text.slice(...gap);
      if (token.loc.start.line > previous.loc.end.line && token.loc.start.column === indent.length) return;
      context.report({
        loc: token.loc,
        messageId,
        fix: /^\s*$/.test(actual) ? (fixer) => fixer.replaceTextRange(gap, expected) : null,
      });
    }
    return {
      MethodDefinition(node) {
        if (node.kind !== 'constructor' || !node.value.body) return;
        const indent = source.lines[node.loc.start.line - 1].match(/^\s*/)[0];
        const openingBrace = source.getFirstToken(node.value.body);
        const closingParen = source.getTokenBefore(openingBrace);
        const tokens = source.getTokens(node).filter((token) => token.range[0] <= openingBrace.range[0]);
        // Measure a hypothetical single-line signature. Never rewrite parameter expressions,
        // comments or literal contents merely to calculate its width.
        let signature = '';
        let previous;
        for (const token of tokens) {
          if (token.type === 'Punctuator' && token.value === ',' && source.getTokenAfter(token) === closingParen) continue;
          if (previous) {
            const gap = source.text.slice(previous.range[1], token.range[0]);
            const afterOpenParen = previous.type === 'Punctuator' && previous.value === '(';
            const beforeCloseParen = token.type === 'Punctuator' && token.value === ')';
            const separator = gap || (previous.type === 'Punctuator' && previous.value === ',') || token === openingBrace;
            if (!afterOpenParen && !beforeCloseParen && separator) signature += ' ';
          }
          signature += source.getText(token);
          previous = token;
        }
        const width = node.loc.start.column + [...signature].length;
        const comments = source.getCommentsInside(node).some((comment) => comment.range[0] < openingBrace.range[0]);
        const multilineParameter = node.value.params.some((parameter) => /[\r\n]/.test(source.getText(parameter)));
        if (width <= maxLength && tokens[0].loc.start.line !== openingBrace.loc.start.line && !comments && !multilineParameter) {
          context.report({
            node,
            messageId: 'singleLine',
            data: { maxLength },
            fix: (fixer) => fixer.replaceTextRange([tokens[0].range[0], openingBrace.range[1]], signature),
          });
          return;
        }
        if (width > maxLength && node.value.params.length) {
          for (const parameter of node.value.params)
            newlineBefore(source.getFirstToken(parameter), `${indent}  `, 'parameter');
          newlineBefore(closingParen, indent, 'closingParen');
        }
        if (node.value.params.length) {
          const last = source.getTokenBefore(closingParen);
          if (last.type === 'Punctuator' && last.value === ',')
            context.report({
              node: last,
              messageId: 'trailingComma',
              fix: (fixer) => {
                return fixer.remove(last);
              },
            });
        }
        const bracePrevious = source.getTokenBefore(openingBrace, { includeComments: true });
        const braceGap = [bracePrevious.range[1], openingBrace.range[0]];
        // Never move a brace into a line comment.
        if (
          bracePrevious.type !== 'Line'
          && /^\s*$/.test(source.text.slice(...braceGap))
          && source.text.slice(...braceGap) !== ' '
        ) {
          context.report({
            loc: openingBrace.loc,
            messageId: 'openingBrace',
            fix: (fixer) => {
              return fixer.replaceTextRange(braceGap, ' ');
            },
          });
        }
        const closingBrace = source.getLastToken(node.value.body);
        if (node.value.body.body.length === 0) {
          const gap = [openingBrace.range[1], closingBrace.range[0]];
          const actual = source.text.slice(...gap);
          if (/^\s+$/.test(actual))
            context.report({
              loc: closingBrace.loc,
              messageId: 'emptyBody',
              fix: (fixer) => {
                return fixer.replaceTextRange(gap, '');
              },
            });
        }
      },
    };
  },
};
