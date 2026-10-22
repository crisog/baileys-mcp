const config = {
  '*.{md,json,yml,yaml}': 'oxfmt --no-error-on-unmatched-pattern',
  '*.{js,ts}': ['oxlint --fix --deny-warnings', 'oxfmt --no-error-on-unmatched-pattern'],
  // A function command runs without the staged file list, so tsrs checks the whole project
  '*.ts': () => 'tsrs --noEmit'
};

export default config;
