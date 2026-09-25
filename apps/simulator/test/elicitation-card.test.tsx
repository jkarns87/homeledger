import { act, cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ElicitationCard } from '../src/components/ElicitationCard.js';
import { ProgressMeter } from '../src/components/ProgressMeter.js';
import { Transcript } from '../src/components/Transcript.js';
import { INITIAL_STATE, type PendingQuestion } from '../src/lib/transcript.js';

const choice: PendingQuestion = {
  elicitationId: 'e1',
  turnId: 't1',
  callId: 'c1',
  tool: 'book_service',
  prompt: 'Who should I book for the water heater?',
  field: 'provider',
  kind: 'choice',
  options: [
    { value: 'prov_kettle_water', label: 'Kettle Creek Water Heaters' },
    { value: 'prov_anode_and_co', label: 'Anode and Company' },
    { value: 'prov_hotline_tank', label: 'Hotline Tank Service' }
  ]
};

const confirm: PendingQuestion = {
  elicitationId: 'e3',
  turnId: 't1',
  callId: 'c1',
  tool: 'book_service',
  prompt: 'Book Kettle Creek Water Heaters for Tuesday, September 15, 1 to 3 PM?',
  field: 'confirm',
  kind: 'confirm',
  options: []
};

describe('ElicitationCard, choice', () => {
  it('shows the server’s question once, as the card’s own heading', () => {
    render(<ElicitationCard question={choice} onAnswer={() => {}} />);
    expect(screen.getAllByText(choice.prompt)).toHaveLength(1);
    expect(screen.getByTestId('elicitation').dataset.field).toBe('provider');
  });

  it('offers one button per option, labelled with the display name and never the id', () => {
    render(<ElicitationCard question={choice} onAnswer={() => {}} />);
    for (const option of choice.options) {
      expect(screen.getByRole('button', { name: option.label })).toBeDefined();
      expect(screen.queryByRole('button', { name: option.value })).toBeNull();
    }
    expect(document.body.textContent).not.toContain('prov_kettle_water');
  });

  it('answers with the enum value under the field the server named', () => {
    const onAnswer = vi.fn();
    render(<ElicitationCard question={choice} onAnswer={onAnswer} />);
    screen.getByRole('button', { name: 'Anode and Company' }).click();
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith(choice, 'accept', { provider: 'prov_anode_and_co' });
  });

  it('offers a way out that is a decline, not a made-up answer', () => {
    const onAnswer = vi.fn();
    render(<ElicitationCard question={choice} onAnswer={onAnswer} />);
    screen.getByRole('button', { name: /not now/i }).click();
    expect(onAnswer).toHaveBeenCalledWith(choice, 'decline', undefined);
  });

  it('answers once: a double click sends one answer, and every button is disabled after the first', () => {
    // The final review's I2. A second click used to post the same question
    // again, and the server's 409 for it came back as a failure notice.
    const onAnswer = vi.fn();
    render(<ElicitationCard question={choice} onAnswer={onAnswer} />);
    // Each click inside `act`, so React has re-rendered before the next one:
    // this is the path where the `disabled` attribute is what stops it. The
    // test below takes the other path.
    const anode = screen.getByRole('button', { name: 'Anode and Company' });
    act(() => anode.click());
    act(() => anode.click());
    act(() => screen.getByRole('button', { name: 'Kettle Creek Water Heaters' }).click());
    act(() => screen.getByRole('button', { name: /not now/i }).click());
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith(choice, 'accept', { provider: 'prov_anode_and_co' });
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('drops a second click that lands before the card has re-rendered', () => {
    // A click event dispatched straight at the element, the way a fast double
    // click can arrive before React has applied `disabled`: the ref, not the
    // attribute, is what stops this one.
    const onAnswer = vi.fn();
    render(<ElicitationCard question={choice} onAnswer={onAnswer} />);
    const anode = screen.getByRole('button', { name: 'Anode and Company' });
    const click = () => anode.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    click();
    anode.removeAttribute('disabled');
    click();
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('renders exactly the options it is given, adding and removing nothing', () => {
    render(<ElicitationCard question={choice} onAnswer={() => {}} />);
    expect(screen.getAllByTestId(/^option-/)).toHaveLength(3);
  });

  // Mutation check #7 (Task 12, Step 6) mutates `Transcript`, not
  // `ElicitationCard`, and the brief's own "once" test above only ever
  // mounts the card - it cannot see a duplicate that Transcript introduces
  // because Transcript is never in that test's tree. Confirmed by running
  // the mutation: the whole simulator suite (239 tests) stayed green with
  // `Transcript` echoing `state.pending.prompt`. This test renders both
  // components together, the way `page.tsx` actually does when a question
  // is open, so a prompt duplicated into the transcript has somewhere to be
  // caught.
  it('does not also appear in the transcript when the transcript is rendered alongside it', () => {
    const state = { ...INITIAL_STATE, pending: choice };
    render(
      <>
        <Transcript state={state} theme="dark" />
        <ElicitationCard question={choice} onAnswer={() => {}} />
      </>
    );
    expect(screen.getAllByText(choice.prompt)).toHaveLength(1);
  });
});

describe('ElicitationCard, confirm', () => {
  it('sends a boolean under the field, both ways', () => {
    const onAnswer = vi.fn();
    render(<ElicitationCard question={confirm} onAnswer={onAnswer} />);
    screen.getByRole('button', { name: /^yes/i }).click();
    expect(onAnswer).toHaveBeenLastCalledWith(confirm, 'accept', { confirm: true });
    // A card answers once, so the other half is a fresh card.
    cleanup();
    render(<ElicitationCard question={confirm} onAnswer={onAnswer} />);
    // `/^no, don/i`, not `/^no/i`. In confirm mode the card renders three
    // buttons and two of them start with "No": "No, don't book it" and the
    // always-present "Not now". `getByRole` with the looser pattern matches
    // both and throws "Found multiple elements" before it can assert anything,
    // so the test failed rather than passing vacuously - but it still could
    // not reach its own "Expected: PASS".
    screen.getByRole('button', { name: /^no, don/i }).click();
    expect(onAnswer).toHaveBeenLastCalledWith(confirm, 'accept', { confirm: false });
  });

  it('keeps "No, don’t book it" and "Not now" distinguishable, because they mean different things', () => {
    // Saying no to this booking is an ANSWER - the server writes nothing and
    // the turn moves on. "Not now" is a decline of the question itself. They
    // travel as different payloads and a card that let one be clicked for the
    // other would make a refusal indistinguishable from a withdrawal.
    const onAnswer = vi.fn();
    render(<ElicitationCard question={confirm} onAnswer={onAnswer} />);
    const no = screen.getByRole('button', { name: 'No, don’t book it' });
    const notNow = screen.getByRole('button', { name: /not now/i });
    expect(no).not.toBe(notNow);
    notNow.click();
    expect(onAnswer).toHaveBeenLastCalledWith(confirm, 'decline', undefined);
  });

  it('says "book it" only when the question is book_service confirming a booking', () => {
    // The deployed runtime also offers the model `echo_confirm`, a yes/no
    // question that books nothing. Labelled "Yes, book it", the card would
    // tell a person they were booking something when they were not.
    render(<ElicitationCard question={{ ...confirm, tool: 'echo_confirm', prompt: 'Proceed?' }} onAnswer={() => {}} />);
    expect(screen.getByRole('button', { name: 'Yes' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'No' })).toBeDefined();
    expect(screen.getByTestId('elicitation').textContent).not.toMatch(/book/i);
    cleanup();
    render(<ElicitationCard question={confirm} onAnswer={() => {}} />);
    expect(screen.getByRole('button', { name: 'Yes, book it' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'No, don’t book it' })).toBeDefined();
  });

  it('shows no option list at all', () => {
    render(<ElicitationCard question={confirm} onAnswer={() => {}} />);
    expect(screen.queryAllByTestId(/^option-/)).toHaveLength(0);
  });
});

describe('ProgressMeter', () => {
  it('reports the step, the total and the message to assistive technology', () => {
    render(<ProgressMeter progress={{ callId: 'c1', progress: 2, total: 3, message: 'Comparing arrival windows' }} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    expect(bar.getAttribute('aria-valuemax')).toBe('3');
    expect(screen.getByText('Comparing arrival windows')).toBeDefined();
  });

  it('renders the first and the last step of the documented run', () => {
    const { rerender } = render(<ProgressMeter progress={{ callId: 'c1', progress: 0, total: 3, message: 'Checking for openings' }} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    rerender(<ProgressMeter progress={{ callId: 'c1', progress: 3, total: 3, message: 'Found three windows' }} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3');
  });
});
