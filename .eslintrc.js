module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: [ './tsconfig.json' ],
    tsconfigRootDir: __dirname
  },
  plugins: [
      '@typescript-eslint'
  ],
  extends: [
      'eslint:recommended',
      'plugin:@typescript-eslint/recommended'
  ],
  rules: {
    '@typescript-eslint/no-floating-promises': 2,
    '@typescript-eslint/no-misused-promises': 2,
    "@typescript-eslint/no-inferrable-types": 0,
    "@typescript-eslint/no-empty-function": 1,
    "@typescript-eslint/no-empty-interface": 0,
    'no-console': 1
  },
  ignorePatterns: [ '.eslintrc.js' ]
}
