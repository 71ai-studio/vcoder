# Sandbox Project Rules

This is a tiny Node.js module. Follow these rules STRICTLY:

## Code style

- Use `const`, never `let` or `var`.
- Use arrow functions, never `function` keyword for top-level exports.
- Export as ESM `module.exports = { ... }` style (CommonJS).
- No semicolons at end of statements.

## Testing

- `npm test` is the canonical verification command.
- Tests live in `test.js`.
