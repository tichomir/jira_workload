'use strict';

const app = require('./app');
const { startGuard } = require('./services/jobTimeoutGuard');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Jira Workload backend listening on port ${PORT}`);
  // Start the job timeout guard after the server is listening so that
  // the initial dead-job recovery scan runs with a fully-initialised db.
  startGuard();
});
