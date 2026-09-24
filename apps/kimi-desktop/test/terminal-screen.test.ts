import { describe, expect, it } from 'vitest';

import { TerminalScreen } from '../src/renderer/terminal-screen';

/** The visible text of a screen, right-trimmed per line. */
function text(screen: TerminalScreen): string[] {
  return screen.visible().map((row) => row.map((cell) => cell.char).join('').replace(/\s+$/, ''));
}

describe('TerminalScreen', () => {
  it('writes plain text', () => {
    const screen = new TerminalScreen(20, 3);
    screen.write('hello');
    expect(text(screen)[0]).toBe('hello');
    expect(screen.cursor()).toStrictEqual({ row: 0, col: 5 });
  });

  it('treats \\r\\n as a new line, not two', () => {
    const screen = new TerminalScreen(20, 3);
    screen.write('one\r\ntwo');
    expect(text(screen)[0]).toBe('one');
    expect(text(screen)[1]).toBe('two');
  });

  it('wraps at the right edge', () => {
    const screen = new TerminalScreen(4, 3);
    screen.write('abcdef');
    expect(text(screen)[0]).toBe('abcd');
    expect(text(screen)[1]).toBe('ef');
  });

  it('scrolls when the cursor passes the last row', () => {
    const screen = new TerminalScreen(10, 2);
    screen.write('a\r\nb\r\nc');
    expect(text(screen)[0]).toBe('b');
    expect(text(screen)[1]).toBe('c');
  });

  it('applies backspace', () => {
    const screen = new TerminalScreen(10, 2);
    screen.write('ab\bc');
    expect(text(screen)[0]).toBe('ac');
  });

  it('handles tab stops', () => {
    const screen = new TerminalScreen(20, 2);
    screen.write('a\tb');
    expect(text(screen)[0]).toBe('a       b');
  });

  it('moves the cursor with CSI sequences', () => {
    const screen = new TerminalScreen(20, 3);
    screen.write('\u001B[2;3Hx');
    expect(text(screen)[1]).toBe('  x');
  });

  it('honours relative cursor movement', () => {
    const screen = new TerminalScreen(20, 3);
    // From column 2, moving back 2 lands on column 0 and overwrites 'a'.
    screen.write('ab\u001B[2Dc');
    expect(text(screen)[0]).toBe('cb');
  });

  it('erases from the cursor to the end of the line', () => {
    const screen = new TerminalScreen(10, 2);
    // Cursor ends on column 2, so everything from there is cleared.
    screen.write('abcdef\u001B[4D\u001B[0K');
    expect(text(screen)[0]).toBe('ab');
  });

  it('erases the whole display', () => {
    const screen = new TerminalScreen(10, 3);
    screen.write('one\r\ntwo\r\nthree\u001B[2J');
    expect(text(screen).join('')).toBe('');
  });

  it('records SGR attributes without losing the text', () => {
    const screen = new TerminalScreen(20, 2);
    screen.write('\u001B[31mred\u001B[0m plain');
    const row = screen.visible()[0] ?? [];
    expect(row.map((cell) => cell.char).join('').trimEnd()).toBe('red plain');
    expect(row[0]?.fg).toBe(1);
    expect(row[4]?.fg).toBeNull();
  });

  it('handles bold, underline and inverse', () => {
    const screen = new TerminalScreen(20, 2);
    screen.write('\u001B[1;4;7mx');
    const cell = screen.visible()[0]?.[0];
    expect(cell).toMatchObject({ bold: true, underline: true, inverse: true });
  });

  it('accepts a 256-colour foreground', () => {
    const screen = new TerminalScreen(20, 2);
    screen.write('\u001B[38;5;196mx');
    expect(screen.visible()[0]?.[0]?.fg).toBe(196);
  });

  it('accepts a truecolour foreground and lands in the cube', () => {
    const screen = new TerminalScreen(20, 2);
    screen.write('\u001B[38;2;255;0;0mx');
    const fg = screen.visible()[0]?.[0]?.fg;
    expect(fg).toBeGreaterThanOrEqual(16);
    expect(fg).toBeLessThan(232);
  });

  it('ignores an OSC title without leaking it to the screen', () => {
    const screen = new TerminalScreen(20, 2);
    screen.write('\u001B]0;my title\u0007ok');
    expect(text(screen)[0]).toBe('ok');
  });

  it('saves and restores the cursor', () => {
    const screen = new TerminalScreen(20, 3);
    screen.write('ab\u001B7\u001B[2;1H\u001B8c');
    expect(text(screen)[0]).toBe('abc');
  });

  it('confines scrolling to a set scroll region', () => {
    const screen = new TerminalScreen(6, 4);
    screen.write('1\r\n2\r\n3\r\n4');
    // Region is rows 1-2 (1-based). Feeding at the region's bottom scrolls only
    // the region; rows 3 and 4 must not move.
    screen.write('\u001B[1;2r\u001B[2;1H');
    screen.write('\r\nX');
    expect(text(screen)).toStrictEqual(['2', 'X', '3', '4']);
  });

  it('resizes without losing the visible text', () => {
    const screen = new TerminalScreen(10, 3);
    screen.write('keep me');
    screen.resize(20, 5);
    expect(text(screen)[0]).toBe('keep me');
    expect(screen.cols).toBe(20);
    expect(screen.rows).toBe(5);
  });

  it('clamps the cursor after shrinking', () => {
    const screen = new TerminalScreen(20, 5);
    screen.write('\u001B[5;20H');
    screen.resize(10, 2);
    const { row, col } = screen.cursor();
    expect(row).toBeLessThan(2);
    expect(col).toBeLessThan(10);
  });

  it('shows the newest rows, not the oldest, after scrolling', () => {
    const screen = new TerminalScreen(10, 3);
    for (let i = 0; i < 5000; i += 1) screen.write(`line ${i}\r\n`);
    // The live view is the end of the buffer. Taking it from the front would
    // pin the panel to output from thousands of lines ago.
    expect(screen.visible()).toHaveLength(3);
    // The final newline leaves the cursor on a fresh blank line, as a real
    // terminal does, so the last two writes occupy the two rows above it.
    expect(text(screen)).toStrictEqual(['line 4998', 'line 4999', '']);
  });

  it('keeps scrollback bounded no matter how much output arrives', () => {
    const screen = new TerminalScreen(10, 3);
    for (let i = 0; i < 5000; i += 1) screen.write(`line ${i}\r\n`);
    expect(screen.scrollback()).toBeLessThanOrEqual(2000);
  });

  it('scrolls back into history and returns to the live screen', () => {
    const screen = new TerminalScreen(10, 3);
    for (let i = 0; i < 50; i += 1) screen.write(`line ${i}\r\n`);
    screen.scrollBy(10);
    expect(screen.scrollingBack).toBe(true);
    // Scrolled back, the view must show older lines than the live screen does.
    expect(text(screen)).not.toContain('newest');
    expect(text(screen).some((line) => line.startsWith('line '))).toBe(true);
    screen.scrollToBottom();
    expect(screen.scrollingBack).toBe(false);
    expect(text(screen)).toStrictEqual(['line 48', 'line 49', '']);
  });

  it('cannot scroll back past the start of the buffer', () => {
    const screen = new TerminalScreen(10, 3);
    screen.write('only\r\n');
    screen.scrollBy(9999);
    expect(screen.visible()).toHaveLength(3);
    expect(text(screen)[0]).toBe('only');
  });

  it('returns to the live screen when new output arrives', () => {
    const screen = new TerminalScreen(10, 3);
    for (let i = 0; i < 50; i += 1) screen.write(`line ${i}\r\n`);
    screen.scrollBy(5);
    screen.write('newest\r\n');
    expect(screen.scrollingBack).toBe(false);
    expect(text(screen)).toStrictEqual(['line 49', 'newest', '']);
  });

  it('stays put while the view is held', () => {
    const screen = new TerminalScreen(10, 3);
    for (let i = 0; i < 50; i += 1) screen.write(`line ${i}\r\n`);
    screen.scrollBy(5);
    screen.holdScroll = true;
    screen.write('more\r\n');
    expect(screen.scrollingBack).toBe(true);
    screen.holdScroll = false;
  });

  it('resets on the full-reset sequence', () => {
    const screen = new TerminalScreen(10, 3);
    screen.write('junk\u001Bc');
    expect(text(screen).join('')).toBe('');
    expect(screen.cursor()).toStrictEqual({ row: 0, col: 0 });
  });
});
