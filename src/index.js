require('dotenv').config();
const express = require('express');
const cors = require('cors');
const submitRouter = require('./routes/submit');
const healthRouter = require('./routes/health');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3006;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/health', healthRouter);
app.use('/submit', submitRouter);
app.use('/admin', adminRouter);

app.listen(PORT, () => {
  console.log(`zing-forms-service running on port ${PORT}`);
});
