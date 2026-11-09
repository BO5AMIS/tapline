// Fallback for bundlers that do not read package.json "exports":
// `import '@tapline/react-native/register'` resolves to this file.
require('./dist/register');
