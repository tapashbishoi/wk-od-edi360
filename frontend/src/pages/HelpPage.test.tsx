import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = { userGuide: vi.fn() };
vi.mock('@/services/api', () => ({ api, errorMessage: (e: unknown, f: string) => (e instanceof Error ? e.message : f) }));

const { default: HelpPage } = await import('./HelpPage');

describe('Help page', () => {
  let tab: { location: { href: string }; close: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.clearAllMocks();
    tab = { location: { href: '' }, close: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => tab));
    URL.createObjectURL = vi.fn(() => 'blob:guide');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists what the guide covers', () => {
    render(<HelpPage />);
    expect(screen.getByTestId('chapters').children).toHaveLength(20);
    expect(screen.getByText('Cookbook: step-by-step recipes')).toBeInTheDocument();
  });

  it('opens the guide in a new tab once it has been fetched with the session', async () => {
    api.userGuide.mockResolvedValue(new Blob(['%PDF-1.4']));
    render(<HelpPage />);
    fireEvent.click(screen.getByText('Open the guide'));
    await waitFor(() => expect(tab.location.href).toBe('blob:guide'));
    expect(api.userGuide).toHaveBeenCalledTimes(1);
  });

  it('closes the empty tab and says so when the guide cannot be fetched', async () => {
    api.userGuide.mockRejectedValue(new Error('The user guide is not available'));
    render(<HelpPage />);
    fireEvent.click(screen.getByText('Open the guide'));
    expect(await screen.findByText('The user guide is not available')).toBeInTheDocument();
    expect(tab.close).toHaveBeenCalled();
  });

  it('downloads the PDF under its own name', async () => {
    api.userGuide.mockResolvedValue(new Blob(['%PDF-1.4']));
    let a: HTMLAnchorElement | undefined;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { a = this; });
    render(<HelpPage />);
    fireEvent.click(screen.getByText('Download PDF'));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(a!.download).toBe('EDI360-User-Guide.pdf');
    expect(a!.href).toContain('blob:guide');
    click.mockRestore();
  });
});
