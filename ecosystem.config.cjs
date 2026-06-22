module.exports = {
  apps: [{
    name: 'inventory-bot',
    script: 'src/bot.js',
    cwd: __dirname,
    watch: false,
    restart_delay: 5000,
    max_restarts: 10,
    env: { NODE_ENV: 'production' }
  }]
};
