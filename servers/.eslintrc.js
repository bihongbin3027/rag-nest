const path = require('path')

module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: path.resolve(__dirname, 'tsconfig.eslint.json'),
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/semi': [ 2, 'never' ],
    '@typescript-eslint/no-unused-vars': 0,
    'semi': 0,
    // 缩进/引号/数组空格/末行换行 全部交给 Prettier（.prettierrc）
    'array-bracket-spacing': 'off',
    'eol-last': 'off',
    'quotes': 'off',
    'indent': 'off',
    'eqeqeq': [2, 'allow-null'],
  },
};
