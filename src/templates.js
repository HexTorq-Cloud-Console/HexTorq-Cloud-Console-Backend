export const serviceTemplates = [
  {
    key: 'node-pm2',
    name: 'Node.js / PM2',
    type: 'PM2',
    description: 'Install dependencies, build the application, and restart an existing PM2 process.',
    commands: { install: 'npm ci', build: 'npm run build', start: 'pm2 restart <process-name> --update-env' },
  },
  {
    key: 'python-pm2',
    name: 'Python / PM2',
    type: 'PM2',
    description: 'Install Python requirements, run migrations, collect static files, and restart PM2.',
    commands: { install: '<venv>/bin/pip install -r requirements.txt', build: '<venv>/bin/python manage.py migrate --noinput', start: 'pm2 restart <process-name> --update-env' },
  },
  {
    key: 'vite-static',
    name: 'Vite static frontend',
    type: 'STATIC_FRONTEND',
    description: 'Install dependencies, build dist files, and publish them to the configured Nginx directory.',
    commands: { install: 'npm ci', build: 'npm run build', publish: 'Copy dist/. to deployDirectory' },
  },
];
