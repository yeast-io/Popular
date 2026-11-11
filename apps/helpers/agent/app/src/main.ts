import { createApp } from 'vue';
import { AgentRoot } from '@movie-hub/helper-agent-ui';
import '@movie-hub/helper-agent-ui/styles.css';
import { createDesktopAgentClient, createDesktopAgentHost } from './desktop-agent.client';

createApp(AgentRoot, { client: createDesktopAgentClient(), host: createDesktopAgentHost() }).mount('#app');
