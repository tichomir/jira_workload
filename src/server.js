'use strict';

const app = require('./app');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Jira Workload backend listening on port ${PORT}`);
});
