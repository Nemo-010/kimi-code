/**
 * Proof for the "thinking traces / expanded tool detail for swarm+subagents"
 * study. These tests assert the exact behaviours read out of the source:
 *
 *   1. Main-agent thinking expands under Ctrl+O.
 *   2. A single-subagent Agent card reports no hidden content and does NOT
 *      grow when expanded — its live window is fixed at THINKING_PREVIEW_LINES.
 *   3. SubagentActivityStore (the /tasks background-agent detail view) never
 *      records thinking.delta, only assistant.delta.
 *   4. The swarm path funnels thinking.delta and assistant.delta into the
 *      same appendModelDelta() buffer, so thinking is shown as the generic
 *      one-line cell label.
 */

import type { Event } from '@moonshot-ai/kimi-code-sdk';
import type { TUI } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { AgentSwarmProgressComponent } from '#/tui/components/messages/agent-swarm-progress';
import { THINKING_PREVIEW_LINES } from '#/tui/constant/rendering';
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

describe('proof: main thinking is expandable', () => {
  it('hides trailing thinking lines when collapsed and reveals them on expand', () => {
    const lines = Array.from({ length: 8 }, (_v, i) => `THOUGHT-${String(i + 1)}`);
    const thinking = new ThinkingComponent(lines.join('\n'), true, 'finalized');

    const collapsed = strip(thinking.render(100).join('\n'));
    expect(collapsed).toContain('ctrl+o to expand');
    expect(collapsed).toContain('THOUGHT-1');
    expect(collapsed).not.toContain('THOUGHT-8');

    thinking.setExpanded(true);
    const expanded = strip(thinking.render(100).join('\n'));
    expect(expanded).toContain('THOUGHT-8');
  });
});

describe('proof: single-subagent card is not expandable', () => {
  it('reports no hidden content and keeps the same height after setExpanded(true)', () => {
    const card = new ToolCallComponent(
      { id: 'call_agent_1', name: 'Agent', args: { description: 'explore' } },
      undefined,
      stubTui(40),
    );
    card.appendSubagentText(
      ['THOUGHT-1', 'THOUGHT-2', 'THOUGHT-3', 'THOUGHT-4', 'THOUGHT-5'].join('\n'),
      'thinking',
    );

    // Ctrl+O would reveal nothing: the footer's hidden-content probe is false.
    expect(card.hasHiddenContent()).toBe(false);

    const collapsed = strip(card.render(100).join('\n'));
    expect(collapsed).toContain('THOUGHT-5');
    expect(collapsed).not.toContain('THOUGHT-1');

    const collapsedHeight = card.render(100).length;
    card.setExpanded(true);
    const expanded = strip(card.render(100).join('\n'));
    const expandedHeight = card.render(100).length;

    // Expanding changes neither the visible text nor the card height.
    expect(expandedHeight).toBe(collapsedHeight);
    expect(expanded).not.toContain('THOUGHT-1');
    expect(expanded).toContain('THOUGHT-5');
    expect(THINKING_PREVIEW_LINES).toBe(2);

    card.dispose();
  });
});

describe('proof: activity store drops thinking', () => {
  it('records assistant text but never thinking text', () => {
    const store = new SubagentActivityStore();
    store.ensureRecord({
      agentId: 'agent-1',
      agentName: 'explore',
      parentToolCallId: 'call_agent_1',
    });

    store.applyEvent(assistantDelta('agent-1', 'visible answer'));
    store.applyEvent(thinkingDelta('agent-1', 'SECRET-REASONING'));

    const record = store.get('agent-1');
    expect(record).toBeDefined();
    expect(record?.steps[0]?.textTail).toBe('visible answer');
    // The thinking text is nowhere in the retained record.
    expect(JSON.stringify(record)).not.toContain('SECRET-REASONING');
  });
});

describe('proof: swarm merges thinking into the cell label buffer', () => {
  it('routes thinking.delta and assistant.delta to the same appendModelDelta', () => {
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

    expect(spy.appendModelDelta).toHaveBeenCalledTimes(2);
    expect(spy.appendModelDelta).toHaveBeenNthCalledWith(1, {
      agentId: 'agent-1',
      delta: 'reasoning',
    });
    expect(spy.appendModelDelta).toHaveBeenNthCalledWith(2, {
      agentId: 'agent-1',
      delta: 'output',
    });
  });

  it('renders the thinking text as the one-line member label', () => {
    const progress = new AgentSwarmProgressComponent({ description: 'swarm' });
    progress.updateArgs({ items: ['task one'] });
    progress.registerSubagent({ agentId: 'agent-1', swarmIndex: 1 });
    progress.appendModelDelta({ agentId: 'agent-1', delta: 'I should inspect the parser' });

    const out = strip(progress.render(160).join('\n'));
    expect(out).toContain('I should inspect the parser');

    progress.dispose();
  });
});
