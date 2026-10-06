module.exports = {
  apps: [
    {
      name: 'hydraulic-system',
      script: 'server.js',
      cwd: __dirname,
      instances: 1, // Single instance required for SQLite database integrity
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 9999,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 9999,
        TRUST_PROXY: '1',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      min_uptime: '10s',
      max_restarts: 10,
    },
  ],
};
