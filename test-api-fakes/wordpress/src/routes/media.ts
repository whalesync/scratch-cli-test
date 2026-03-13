import { Router, Request } from 'express';
import { store } from '../store';

const router = Router();

// POST /wp/v2/media — Upload media file
router.post('/wp/v2/media', (req: Request, res) => {
  const contentDisposition = req.headers['content-disposition'] as string | undefined;
  const contentType = req.headers['content-type'] || 'application/octet-stream';

  let filename = 'upload';
  if (contentDisposition) {
    const filenameMatch = contentDisposition.match(/filename="?([^";\s]+)"?/);
    if (filenameMatch) {
      filename = filenameMatch[1];
    }
  }

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const filesize = body.length;

    const media = store.addMedia({
      source_url: `${store.siteInfo.url}/wp-content/uploads/${filename}`,
      mime_type: contentType as string,
      title: { rendered: filename.replace(/\.[^.]+$/, '') },
      media_details: {
        filesize,
        width: 0,
        height: 0,
      },
    });

    res.status(201).json(media);
  });
});

export default router;
