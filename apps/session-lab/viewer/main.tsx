import {createRoot} from 'react-dom/client';
import {LabWorkbench} from '../../desktop/src/renderer/lab-workbench.js';
import '../../desktop/src/renderer/style.css';
import type {LabPort} from '@msm/contracts';
declare global {interface Window {labPort:LabPort;}}
createRoot(document.getElementById('root')!).render(<LabWorkbench port={window.labPort}/>);
