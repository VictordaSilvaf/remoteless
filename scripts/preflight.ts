import {checkInstallation} from './support/installation.js';

try {console.log(JSON.stringify(await checkInstallation(process.env.MSM_RUNTIME_DIR??'.runtime'),null,2));}
catch(error){console.error(error instanceof Error?error.message:'PREFLIGHT_FAILED');process.exitCode=1;}
