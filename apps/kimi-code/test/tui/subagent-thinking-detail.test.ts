/**
 * Subagent / swarm thinking and detail display.
 *
 * Covers the behaviours this fork changes:
 *   1. main-agent thinking expands under Ctrl+O;
 *   2. a single-subagent Agent card is expandable and reveals the full child
 *      thinking/output instead of a fixed two-row window;
 *   3. SubagentActivityStore records thinking.delta alongside assistant.delta;
 *   4. the swarm path keeps thinking and output distinct and the expanded
 *      panel renders both per member.
 */

import type { Event } from '@moonshot-ai/kimi-code-sdk';
import type { TUI } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { AgentSwarmProgressComponent } from '#/tui/components/messages/agent-swarm-progress';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { SubAgentEventHandler } from '#/tui/controllers/subagent-event-handler';
import { SubagentActivityStore } from '#/tui/controllers/subagent-activity-store';

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

function strip(text: string): string {
  return text
    .replaceAll(/\u001B\[[0-9;]*m/g, '')
    .replaceAll(new RegExp(`${ESC}\\]8;;[^${BEL}]*${BEL}`, 'g'), '');
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

describe('main thinking expands', () => {
  it('hides trailing lines when collapsed and reveals them on expand', () => {
    const lines = Array.from({ length: 8 }, (_v, i) => `THOUGHT-${String(i + 1)}`);
    const thinking = new ThinkingComponent(lines.join('\n'), true, 'finalized');

    const collapsed = strip(thinking.render(100).join('\n'));
    expect(collapsed).toContain('ctrl+o to expand');
    expect(collapsed).toContain('THOUGHT-1');
    expect(collapsed).not.toContain('THOUGHT-8');

    thinking.setExpanded(true);
    expect(strip(thinking.render(100).join('\n'))).toContain('THOUGHT-8');
  });
});

describe('single-subagent card expands', () => {
  it('advertises hidden content and reveals the full thinking trace', () => {
    const card = new ToolCallComponent(
      { id: 'call_agent_1', name: 'Agent', args: { description: 'explore' } },
      undefined,
      stubTui(40),
    );
    card.appendSubagentText(
      ['THOUGHT-1', 'THOUGHT-2', 'THOUGHT-3', 'THOUGHT-4', 'THOUGHT-5'].join('\n'),
      'thinking',
    );

    expect(card.hasHiddenContent()).toBe(true);

    const collapsed = strip(card.render(100).join('\n'));
    expect(collapsed).toContain('THOUGHT-5');
    expect(collapsed).not.toContain('THOUGHT-1');
    const collapsedHeight = card.render(100).length;

    card.setExpanded(true);
    const expanded = strip(card.render(100).join('\n'));
    expect(expanded).toContain('THOUGHT-1');
    expect(expanded).toContain('THOUGHT-5');
    expect(card.render(100).length).toBeGreaterThan(collapsedHeight);

    card.dispose();
  });
});

describe('activity store records thinking', () => {
  it('keeps thinking and assistant text in separate tails', () => {
    const store = new SubagentActivityStore();
    store.ensureRecord({
      agentId: 'agent-1',
      agentName: 'explore',
      parentToolCallId: 'call_agent_1',
    });

    store.applyEvent(assistantDelta('agent-1', 'visible answer'));
    store.applyEvent(thinkingDelta('agent-1', 'SECRET-REASONING'));

    const record = store.get('agent-1');
    expect(record?.steps[0]?.textTail).toBe('visible answer');
    expect(record?.steps[0]?.thinkingTail).toBe('SECRET-REASONING');
  });
});

describe('swarm keeps thinking and output distinct', () => {
  it('routes thinking.delta and assistant.delta with their kind', () => {
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

  it('renders a labelled per-member trace when expanded', () => {
    const progress = new AgentSwarmProgressComponent({ description: 'swarm' });
    progress.updateArgs({ items: ['task one'] });
    progress.registerSubagent({ agentId: 'agent-1', swarmIndex: 1 });
    progress.appendModelDelta({
      agentId: 'agent-1',
      delta: 'I should inspect the parser',
      kind: 'thinking',
    });
    progress.appendModelDelta({ agentId: 'agent-1', delta: 'Found the bug', kind: 'text' });

    const collapsed = strip(progress.render(160).join('\n'));
    expect(collapsed).toContain('I should inspect the parser');
    expect(collapsed).not.toContain('~ I should inspect the parser');
    expect(progress.hasHiddenContent()).toBe(true);

    progress.setExpanded(true);
    const expanded = strip(progress.render(160).join('\n'));
    expect(expanded).toContain('~ I should inspect the parser');
    expect(expanded).toContain('Found the bug');

    progress.dispose();
  });
});
