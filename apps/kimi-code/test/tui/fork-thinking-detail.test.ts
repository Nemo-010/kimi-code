/**
 * Regression tests for this fork's thinking-detail patch: subagent and swarm
 * thinking must be retained and reachable, not folded into the one-line label.
 */

import type { Event } from '@moonshot-ai/kimi-code-sdk';
import type { TUI } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { AgentSwarmProgressComponent } from '#/tui/components/messages/agent-swarm-progress';
import { SubAgentEventHandler } from '#/tui/controllers/subagent-event-handler';
import { SubagentActivityStore } from '#/tui/controllers/subagent-activity-store';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function stubTui(rows: number): TUI {
  return { terminal: { rows }, requestRender: () => {} } as unknown as TUI;
}

function thinkingDelta(agentId: string, delta: string): Event {
  return { type: 'thinking.delta', agentId, delta } as unknown as Event;
}

function assistantDelta(agentId: string, delta: string): Event {
  return { type: 'assistant.delta', agentId, delta } as unknown as Event;
}

describe('fork: solo subagent thinking is expandable', () => {
  it('keeps thinking separate from text and exposes it to ctrl+o', () => {
    const card = new ToolCallComponent(
      { id: 'call_agent_1', name: 'Agent', args: { description: 'explore' } },
      undefined,
      stubTui(40),
    );
    card.appendSubagentText('THOUGHT-1\nTHOUGHT-2\nTHOUGHT-3', 'thinking');

    expect(card.hasHiddenContent()).toBe(true);

    card.setExpanded(true);
    const expanded = strip(card.render(100).join('\n'));
    expect(expanded).toContain('THOUGHT-1');

    card.dispose();
  });
});

describe('fork: activity store retains thinking', () => {
  it('records thinking.delta in thinkingTail and text.delta in textTail', () => {
    const store = new SubagentActivityStore();
    store.ensureRecord({
      agentId: 'agent-1',
      agentName: 'explore',
      parentToolCallId: 'call_agent_1',
    });

    store.applyEvent(assistantDelta('agent-1', 'visible answer'));
    store.applyEvent(thinkingDelta('agent-1', 'SECRET-REASONING'));

    const step = store.get('agent-1')?.steps[0];
    expect(step?.textTail).toBe('visible answer');
    expect(step?.thinkingTail).toBe('SECRET-REASONING');
  });
});

describe('fork: swarm keeps thinking distinct from text', () => {
  it('tags thinking.delta and assistant.delta with different kinds', () => {
    const handler = new SubAgentEventHandler({} as never, {} as never);
    const apply = (
      handler as unknown as {
        applySubagentEventToSwarmProgress: (
          progress: unknown,
          event: Event,
          subagentId: string,
        ) => void;
      }
    ).applySubagentEventToSwarmProgress.bind(handler);

    const spy = {
      appendModelDelta: vi.fn(),
      recordToolCall: vi.fn(),
      setModelDisplay: vi.fn(),
      setEffortDisplay: vi.fn(),
    };

    apply(spy, thinkingDelta('agent-1', 'reasoning'), 'agent-1');
    apply(spy, assistantDelta('agent-1', 'output'), 'agent-1');

    expect(spy.appendModelDelta).toHaveBeenNthCalledWith(1, {
      agentId: 'agent-1',
      delta: 'reasoning',
      kind: 'thinking',
    });
    expect(spy.appendModelDelta).toHaveBeenNthCalledWith(2, {
      agentId: 'agent-1',
      delta: 'output',
      kind: 'text',
    });
  });

  it('renders the latest model text as the member label', () => {
    const progress = new AgentSwarmProgressComponent({ description: 'swarm' });
    progress.updateArgs({ items: ['task one'] });
    progress.registerSubagent({ agentId: 'agent-1', swarmIndex: 1 });
    progress.appendModelDelta({ agentId: 'agent-1', delta: 'I should inspect the parser' });

    const out = strip(progress.render(160).join('\n'));
    expect(out).toContain('I should inspect the parser');

    progress.dispose();
  });
});
