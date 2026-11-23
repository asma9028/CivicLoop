import dotenv from 'dotenv';
import { validateRuntimeConfiguration } from './config/runtime.js';
dotenv.config({ path: new URL('../.env', import.meta.url) });
validateRuntimeConfiguration(process.env);
const { app } = await import('./app.js');

const port = Number(process.env.PORT || 4000);

app.listen(port, () => {
  console.log(`CivicLoop API listening on http://localhost:${port}`);
});
