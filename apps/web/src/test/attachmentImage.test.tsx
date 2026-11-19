import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AttachmentImage } from '../components/AttachmentImage';
import { ApiProvider } from '../context/ApiContext';
import { createTestAdapter } from '../test-adapter/mockServer';

let accountId: string;
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: accountId } }),
}));

function renderImage(...urls: string[]) {
  accountId = 'alice';
  const api = createTestAdapter();
  const client = new QueryClient();
  const getDownload = vi.spyOn(api, 'getDownload');
  for (const url of urls) {
    getDownload.mockResolvedValueOnce({ url, expires_at: '2030-01-01T00:00:00Z' });
  }

  function view(id: string, withThumbnail = false) {
    const attachment = { id, filename: id + '.png', mime_type: 'image/png', size_bytes: 64, position: 0 };
    return (
      <QueryClientProvider client={client}>
        <ApiProvider api={api}>
          {withThumbnail && <AttachmentImage attachment={attachment} variant="grid" />}
          <AttachmentImage attachment={attachment} variant="lightbox" />
        </ApiProvider>
      </QueryClientProvider>
    );
  }

  const { rerender } = render(view('first'));
  return { getDownload, show: (id: string, withThumbnail = false) => rerender(view(id, withThumbnail)) };
}

const refresh = () => screen.findByRole('button', { name: '刷新图片' });
const image = (name = 'first') => screen.findByRole('img', { name: name + '.png' });

it('stops after one renewed grant when both image URLs fail', async () => {
  const { getDownload } = renderImage('/first-grant', '/renewed-grant');
  fireEvent.error(await image());
  await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', '/renewed-grant'));
  fireEvent.error(await image());
  expect(await refresh()).toBeEnabled();
  expect(screen.queryByRole('img')).toBeNull();
  expect(getDownload).toHaveBeenCalledTimes(2);
});

it('offers manual refresh when renewal returns the failed URL without another image event', async () => {
  const user = userEvent.setup();
  const { getDownload } = renderImage('/same', '/same', '/same', '/recovered');
  fireEvent.error(await image());
  await user.click(await refresh());
  const manuallyLoaded = await image();
  expect(manuallyLoaded).toHaveAttribute('src', '/same');
  expect(getDownload).toHaveBeenCalledTimes(3);

  fireEvent.error(manuallyLoaded);
  await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', '/recovered'));
  fireEvent.load(await image());
  expect(screen.queryByRole('button', { name: '刷新图片' })).toBeNull();
  expect(getDownload).toHaveBeenCalledTimes(4);
});

it('starts an independent load on attachment and account changes even with the same signed URL', async () => {
  const { getDownload, show } = renderImage(...Array<string>(6).fill('/same'));
  for (const [account, id] of [['alice', 'first'], ['alice', 'next'], ['bob', 'next']]) {
    accountId = account;
    show(id);
    fireEvent.error(await image(id));
    expect(await refresh()).toBeEnabled();
  }
  expect(getDownload.mock.calls.map(([id]) => id)).toEqual(['first', 'first', 'next', 'next', 'next', 'next']);
});

it('shares a single renewal when thumbnail and lightbox fail at different times', async () => {
  const { getDownload, show } = renderImage('/original', '/renewed');
  show('first', true);
  const [thumbnail, lightbox] = await screen.findAllByRole('img', { name: 'first.png' });
  fireEvent.error(thumbnail);
  await waitFor(() => expect(screen.getAllByRole('img')[0]).toHaveAttribute('src', '/renewed'));
  fireEvent.error(lightbox);
  await waitFor(() => {
    const images = screen.getAllByRole('img');
    expect(images).toHaveLength(2);
    for (const img of images) expect(img).toHaveAttribute('src', '/renewed');
  });
  for (const img of screen.getAllByRole('img')) fireEvent.error(img);
  expect(screen.getAllByRole('button', { name: '刷新图片' })).toHaveLength(2);
  expect(getDownload).toHaveBeenCalledTimes(2);
});
