/** Wrap long arrows and calls inside callbacks without editing expression tokens. */
export default {
  meta: {
    type: 'layout',
    docs: { description: 'Expand arrows and callback calls exceeding the configured line length.' },
    fixable: 'code',
    schema: [
      { type: 'object', properties: { maxLength: { type: 'integer', minimum: 20 } }, additionalProperties: false },
    ],
    messages: {
      arrow: 'Expand this long arrow function using a block and preserve its return value.',
      call: 'Expand the arguments of this long call inside an arrow function.',
      access: 'Keep computed property access attached to its object to avoid an ambiguous newline.',
    },
  },
  create(context) {
    const source = context.sourceCode;
    const limit = context.options[0]?.maxLength ?? 100;
    const selected = new Set();
    const indent = (node) => source.lines[node.loc.start.line - 1].match(/^\s*/)[0];
    const length = (text) => [...text].length;
    const flatten = (node) => {
      return source.getTokens(node, { includeComments: true }).reduce((text, token, index, tokens) => {
        const gap = index ? source.text.slice(tokens[index - 1].range[1], token.range[0]) : '';
        return text + (gap ? ' ' : '') + source.getText(token);
      }, ''
      );
    };
    const long = (node) => {
      return node.loc.start.line === node.loc.end.line
        ? length(source.lines[node.loc.start.line - 1]) > limit
        : node.loc.start.column + length(flatten(node)) > limit;
    };
    const blocked = (node) => {
      for (let parent = node.parent; parent; parent = parent.parent) if (selected.has(parent)) return true;
      return false;
    };
    const inArrow = (node) => {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.type === 'ArrowFunctionExpression') return true;
        // Do not apply callback formatting inside a nested ordinary function/class.
        if (['FunctionExpression', 'FunctionDeclaration', 'ClassExpression', 'ClassDeclaration'].includes(parent.type))
          return false;
      }
      return false;
    };
    // Move only whitespace before tokens. Never indent inside strings, template tokens or comments.
    function shiftedLines(node, amount, excluded = []) {
      const edits = [];
      for (const token of source.getTokens(node, { includeComments: true })) {
        if (
          excluded.some(([start, end]) => {
            return token.range[0] >= start && token.range[0] < end;
          })
        )
          continue;
        const prefix = source.lines[token.loc.start.line - 1].slice(0, token.loc.start.column);
        if (!prefix || !/^\s+$/.test(prefix)) continue;
        edits.push({
          range: [token.range[0] - prefix.length, token.range[0]],
          text: amount >= 0 ? prefix + ' '.repeat(amount) : prefix.slice(0, Math.max(0, prefix.length + amount)),
        });
      }
      return edits;
    }
    function apply(fixer, edits) {
      return edits
        .sort((a, b) => {
          return a.range[0] - b.range[0];
        })
        .map((edit) => {
          return fixer.replaceTextRange(edit.range, edit.text);
        });
    }
    function commentsGap(previous, next, targetIndent, leading = '\n') {
      const comments = source.getTokensBetween(previous, next, { includeComments: true }).filter((token) => {
        return token.type === 'Line' || token.type === 'Block';
      });
      return (
        leading +
        comments
          .map((comment) => {
            return `${targetIndent}${source.getText(comment)}\n`;
          })
          .join('') +
        targetIndent
      );
    }
    return {
      MemberExpression(node) {
        if (!node.computed || node.optional) return;
        const bracket = source.getTokensBetween(node.object, node.property).find(token => token.value === '[');
        if (!bracket) return;
        const previous = source.getTokenBefore(bracket);
        const gap = source.text.slice(previous.range[1], bracket.range[0]);
        // Remove only whitespace; a line comment must never consume the property access.
        if (!/^\s*\n\s*$/.test(gap)) return;
        context.report({
          node,
          messageId: 'access',
          fix: fixer => fixer.removeRange([previous.range[1], bracket.range[0]]),
        });
      },
      ArrowFunctionExpression(node) {
        if (blocked(node) || !long(node)) return;
        const body = node.body;
        const after = source.getTokenAfter(node);
        const trailingGap = after ? source.text.slice(node.range[1], after.range[0]) : '';
        const joinClosing =
          ['CallExpression', 'NewExpression', 'ArrayExpression'].includes(node.parent.type) &&
          after &&
          [')', ',', ';', ']'].includes(after.value) &&
          /^\s*\n\s*$/.test(trailingGap);
        const base = indent(node);
        const inner = base + '  ';
        const arrow = source.getTokenBefore(body, { filter: (token) => token.value === '=>' });
        if (!arrow) return;
        if (body.type === 'BlockStatement') {
          if (body.loc.start.line !== body.loc.end.line || !body.body.length) {
            if (joinClosing)
              context.report({
                node,
                messageId: 'arrow',
                fix: (fixer) => {
                  return fixer.removeRange([node.range[1], after.range[0]]);
                },
              });
            return;
          }
          selected.add(node);
          context.report({
            node,
            messageId: 'arrow',
            fix(fixer) {
              const opening = source.getFirstToken(body),
                closing = source.getLastToken(body);
              const edits = [];
              for (const statement of body.body) {
                const first = source.getFirstToken(statement);
                const previous = source.getTokenBefore(first);
                edits.push({ range: [previous.range[1], first.range[0]], text: commentsGap(previous, first, inner) });
              }
              const previous = source.getTokenBefore(closing);
              edits.push({ range: [previous.range[1], closing.range[0]], text: commentsGap(previous, closing, base) });
              if (joinClosing) edits.push({ range: [node.range[1], after.range[0]], text: '' });
              // Opening brace remains on the arrow's line; statements retain their tokens.
              if (opening.range[0] < arrow.range[1]) return null;
              return apply(fixer, edits);
            },
          });
          return;
        }
        selected.add(node);
        context.report({
          node,
          messageId: 'arrow',
          fix(fixer) {
            // Parentheses around object/sequence expressions must remain inside the return.
            const first = source.getTokenAfter(arrow);
            const comments = source.getTokensBetween(arrow, first, { includeComments: true });
            const lead = comments.map((comment) => `${inner}${source.getText(comment)}\n`).join('');
            const prefix = source.lines[first.loc.start.line - 1].slice(0, first.loc.start.column);
            const shift = /^\s*$/.test(prefix) ? inner.length - prefix.length : 2;
            const edits = shiftedLines(node, shift, [[node.range[0], first.range[0] + 1]]);
            edits.push({ range: [arrow.range[1], first.range[0]], text: ` {\n${lead}${inner}return ` });
            edits.push({ range: [node.range[1], joinClosing ? after.range[0] : node.range[1]], text: `;\n${base}}` });
            return apply(fixer, edits);
          },
        });
      },
      CallExpression(node) {
        if (blocked(node) || !inArrow(node) || !node.arguments.length) return;
        // Keep multiline argument tokens intact; align their boundary whitespace.
        const first = source.getFirstToken(node.arguments[0]);
        const last = source.getLastToken(node);
        if (!long(node)) return;
        if (first.loc.start.line !== last.loc.start.line) {
          const base = indent(node),
            inner = base + '  ';
          const edits = [];
          for (const argument of node.arguments) {
            const token = source.getFirstToken(argument);
            const prefix = source.lines[token.loc.start.line - 1].slice(0, token.loc.start.column);
            if (/^\s+$/.test(prefix) && prefix !== inner) {
              edits.push({ range: [token.range[0] - prefix.length, token.range[0]], text: inner });
            }
          }
          const previous = source.getTokenBefore(last);
          const gap = source.text.slice(previous.range[1], last.range[0]);
          const closingGap =
            node.arguments.at(-1).type === 'ArrowFunctionExpression' && previous.value === '}' ? '' : `\n${base}`;
          if (/^\s*$/.test(gap) && gap !== closingGap) {
            edits.push({ range: [previous.range[1], last.range[0]], text: closingGap });
          }
          if (edits.length) {
            selected.add(node);
            context.report({ node, messageId: 'call', fix: (fixer) => apply(fixer, edits) });
          }
          return;
        }
        {
          const base = indent(node),
            inner = base + '  ';
          const edits = [];
          const calleeEnd = (node.typeArguments ?? node.callee).range[1];
          let previous = source.getTokens(node).find((token) => {
            return token.value === '(' && token.range[0] >= calleeEnd;
          });
          if (!previous) return null;
          let column = length(inner);
          for (let index = 0; index < node.arguments.length; index++) {
            const argument = node.arguments[index];
            const token = source.getTokenAfter(previous);
            const simple =
              ['Identifier', 'Literal', 'ThisExpression', 'MemberExpression'].includes(argument.type) &&
              argument.loc.start.line === argument.loc.end.line;
            const previousArgument = node.arguments[index - 1];
            const previousSimple =
              previousArgument &&
              ['Identifier', 'Literal', 'ThisExpression', 'MemberExpression'].includes(previousArgument.type);
            const width = length(source.getText(argument)) + 1;
            const hasComments = source.getTokensBetween(previous, token, { includeComments: true }).some((item) => {
              return item.type === 'Line' || item.type === 'Block';
            });
            const sameLine = index > 0 && simple && previousSimple && !hasComments && column + 1 + width <= limit;
            edits.push({
              range: [previous.range[1], token.range[0]],
              text: sameLine ? ' ' : commentsGap(previous, token, inner),
            });
            column = (sameLine ? column + 1 : length(inner)) + width;
            const next = node.arguments[index + 1] ?? last;
            const comma = source.getTokensBetween(argument, next).find((item) => {
              return item.type === 'Punctuator' && item.value === ',';
            });
            previous = comma ?? source.getTokenBefore(last);
          }
          const closingGap =
            node.arguments.at(-1).type === 'ArrowFunctionExpression' &&
            previous.value === '}' &&
            /^\s*$/.test(source.text.slice(previous.range[1], last.range[0]))
              ? ''
              : commentsGap(previous, last, base);
          edits.push({ range: [previous.range[1], last.range[0]], text: closingGap });
          const changes = edits.filter((edit) => source.text.slice(...edit.range) !== edit.text);
          if (changes.length) {
            selected.add(node);
            context.report({ node, messageId: 'call', fix: (fixer) => apply(fixer, changes) });
          }
        }
      },
    };
  },
};
