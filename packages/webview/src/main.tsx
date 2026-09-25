import { createRoot } from 'react-dom/client';
import { App, type Layout } from './App.js';
import './styles.css';

const layout: Layout = document.body.dataset.layout === 'sidebar' ? 'sidebar' : 'panel';
createRoot(document.getElementById('root')!).render(<App layout={layout} />);

if (import.meta.env.DEV) void import('./dev.js');
