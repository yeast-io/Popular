/** Count conditional-expression nesting in scripts and Vue template expressions. */
export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Limit ternary expressions to two levels, including conditions and object fields.' },
    schema: [],
    messages: { tooDeep: 'Keep ternary expressions to at most two levels. Use a lookup table, named value, or explicit branches.' },
  },
  create(context) {
    const visitor = {
      ConditionalExpression(node) {
        let depth = 1;
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(parent.type)) break;
          if (parent.type === 'ConditionalExpression') depth++;
        }
        if (depth > 2) context.report({ node, messageId: 'tooDeep' });
      },
    };
    const services = context.sourceCode.parserServices;
    if (services.defineTemplateBodyVisitor) return services.defineTemplateBodyVisitor(visitor, visitor);
    return visitor;
  },
};
