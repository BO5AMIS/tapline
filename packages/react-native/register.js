// Fallback for bundlers that do not read package.json "exports":
// `import 'react-native-tapline/register'` resolves to this file.
require('./dist/register');
