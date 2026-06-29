const { spawn } = require('child_process');

const ngrok = spawn('ngrok', [
  'http', '3000',
  '--url=procurer-affecting-hypnoses.ngrok-free.dev'
], { stdio: 'inherit' });

ngrok.on('close', (code) => {
  console.log(`ngrok exited with code ${code}`);
  process.exit(code);
});

ngrok.on('error', (err) => {
  console.error('Failed to start ngrok:', err);
  process.exit(1);
});
