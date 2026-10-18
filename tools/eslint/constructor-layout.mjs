/** Constructor-only layout rule. Preserves parameter expressions and comments. */
export default {
  meta: {
    type: 'layout',
    docs: { description: 'Use multiline constructor parameters, no trailing comma, and same-line body braces.' },
    fixable: 'whitespace',
    schema: [],
    messages: {
      parameter: 'Put each constructor parameter on its own line, indented by two spaces.',
      closingParen: 'Put the constructor closing parenthesis on its own line.',
      openingBrace: 'Use one space between the closing parenthesis and the opening brace.',
      trailingComma: 'Do not put a trailing comma after the last constructor parameter.',
      emptyBody: 'Keep an empty constructor body as {} on the closing-parenthesis line.',
      body: 'Put constructor body statements and the closing brace on separate lines.',
    },
  },
  create(context) {
    const source = context.sourceCode;
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
        fix: /^\s*$/.test(actual) ? fixer => fixer.replaceTextRange(gap, expected) : null,
      });
    }
    return {
      MethodDefinition(node) {
        if (node.kind !== 'constructor' || !node.value.body) return;
        const indent = source.lines[node.loc.start.line - 1].match(/^\s*/)[0];
        for (const parameter of node.value.params) newlineBefore(source.getFirstToken(parameter), `${indent}  `, 'parameter');
        const openingBrace = source.getFirstToken(node.value.body);
        const closingParen = source.getTokenBefore(openingBrace);
        if (node.value.params.length) {
          newlineBefore(closingParen, indent, 'closingParen');
          const last = source.getTokenBefore(closingParen);
          if (last.value === ',') context.report({ node: last, messageId: 'trailingComma', fix: fixer => fixer.remove(last) });
        }
        const bracePrevious = source.getTokenBefore(openingBrace, { includeComments: true });
        const braceGap = [bracePrevious.range[1], openingBrace.range[0]];
        // Never move a brace into a line comment.
        if (bracePrevious.type !== 'Line' && /^\s*$/.test(source.text.slice(...braceGap)) && source.text.slice(...braceGap) !== ' ') {
          context.report({ loc: openingBrace.loc, messageId: 'openingBrace', fix: fixer => fixer.replaceTextRange(braceGap, ' ') });
        }
        const firstStatement = node.value.body.body[0];
        const closingBrace = source.getLastToken(node.value.body);
        if (firstStatement) {
          newlineBefore(source.getFirstToken(firstStatement), `${indent}  `, 'body');
          newlineBefore(closingBrace, indent, 'body');
        } else {
          const gap = [openingBrace.range[1], closingBrace.range[0]];
          const actual = source.text.slice(...gap);
          if (/^\s+$/.test(actual)) context.report({ loc: closingBrace.loc, messageId: 'emptyBody', fix: fixer => fixer.replaceTextRange(gap, '') });
        }
      },
    };
  },
};
