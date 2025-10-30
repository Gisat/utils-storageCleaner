/* filepath: .eslintrc.cjs */
module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: false,
    ecmaVersion: "latest",
    sourceType: "module",
  },
  plugins: ["@typescript-eslint", "import"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended"
  ],
  rules: {
    "no-console": "off",
    "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/consistent-type-imports": ["warn", {
      prefer: "type-imports",
      disallowTypeAnnotations: false
    }],
    "import/order": ["warn", {
      "groups": ["builtin", "external", "internal", "parent", "sibling", "index", "object", "type"],
      "alphabetize": { order: "asc", caseInsensitive: true },
      "newlines-between": "always"
    }]
  },
  ignorePatterns: [
    "dist/",
    "node_modules/",
    "**/*.d.ts"
  ]
};