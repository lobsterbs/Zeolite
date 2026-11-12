import { describe, expect, it } from 'vitest';
import { captureErrorBodyPrefix, ERROR_BODY_CAPTURE_LIMIT } from '../diag';

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe('captureErrorBodyPrefix (#647)', () => {
  it('captures a small error body verbatim', async () => {
    const body = '{"error":{"code":400,"message":"Request contains an invalid argument."}}';
    const text = await captureErrorBodyPrefix(
      streamOf([new TextEncoder().encode(body)]),
    );
    expect(text).toBe(body);
  });

  it('bounds the capture at the limit and cancels the rest', async () => {
    const big = new Uint8Array(ERROR_BODY_CAPTURE_LIMIT + 5000).fill(65);
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
      },
      cancel() {
        cancelled = true;
      },
    });
    const text = await captureErrorBodyPrefix(stream);
    expect(text.length).toBe(ERROR_BODY_CAPTURE_LIMIT);
    expect(cancelled).toBe(true);
  });

  it('returns a partial capture when the stream errors mid-body', async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(encoder.encode('partial'));
        else controller.error(new Error('boom'));
      },
    });
    const text = await captureErrorBodyPrefix(stream);
    expect(text).toBe('partial');
  });
});
