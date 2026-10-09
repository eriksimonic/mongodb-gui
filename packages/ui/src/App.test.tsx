// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';

afterEach(cleanup);

describe('App', () => {
  it('renders the Mongo GUI heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Mongo GUI' })).toBeInTheDocument();
  });

  it('reports that ping is not available when window.mongoGui is missing', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Ping main' }));
    expect(await screen.findByRole('status')).toHaveTextContent('not available in browser');
  });
});
