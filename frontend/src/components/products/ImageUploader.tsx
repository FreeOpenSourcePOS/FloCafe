'use client';

import { useCallback, useState, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import Cropper, { type Area } from 'react-easy-crop';
import { Camera, Link, Upload, X, Check } from 'lucide-react';
import { compressCroppedImage, MAX_RAW_FILE_SIZE } from '@/lib/image-utils';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { useI18n } from '@/hooks/useI18n';
interface ImageUploaderProps {
  /** Current Base64 data URI (or null if no image) */
  value: string | null;
  /** Called when image changes (Base64 data URI) or is cleared (null) */
  onChange: (value: string | null) => void;
  /** Product ID for URL proxy fetch */
  productId?: string;
}

type Mode = 'idle' | 'cropping' | 'url-input';

export default function ImageUploader({ value, onChange, productId }: ImageUploaderProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('idle');
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [aspect] = useState(1); // Always 1:1
  const [urlInput, setUrlInput] = useState('');
  const [fetching, setFetching] = useState(false);
  
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const cropAreaRef = useRef<{ x: number; y: number; width: number; height: number }>({ x: 0, y: 0, width: 0, height: 0 });
  // Cache-busting query param for the existing-image URL below. Lazy-initialized once per
  // mount (the form modal remounts this component each time it opens) instead of calling
  // Date.now() directly during render, which would refetch the image on every re-render.
  const [cacheBust] = useState(() => Date.now());

  const processFile = useCallback(async (file: File) => {
    if (file.size > MAX_RAW_FILE_SIZE) {
      toast.error(`File too large (max ${MAX_RAW_FILE_SIZE / 1024 / 1024} MB)`);
      return;
    }
    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }

    // Load into crop editor
    const reader = new FileReader();
    reader.onload = () => {
      setCropSrc(reader.result as string);
      setMode('cropping');
      setCrop({ x: 0, y: 0 });
      setZoom(1);
    };
    reader.onerror = () => {
      toast.error('Failed to read image file');
    };
    reader.readAsDataURL(file);
  }, []);

  const handleCropComplete = useCallback((_croppedArea: Area, croppedAreaPixels: Area) => {
    cropAreaRef.current = {
      x: croppedAreaPixels.x,
      y: croppedAreaPixels.y,
      width: croppedAreaPixels.width,
      height: croppedAreaPixels.height,
    };
  }, []);

  const handleCropSave = useCallback(async () => {
    if (!cropSrc) return;

    try {
      const img = new Image();
      img.src = cropSrc;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to load image for cropping'));
      });

      // Use the actual pixel coordinates from react-easy-crop, or fall back to full natural size
      const width = cropAreaRef.current.width || img.width;
      const height = cropAreaRef.current.height || img.height;
      const x = cropAreaRef.current.x || 0;
      const y = cropAreaRef.current.y || 0;

      const dataUri = compressCroppedImage(img, { x, y, width, height });
      if (!dataUri) {
        toast.error('Could not compress this image enough. Try a tighter crop or another image.');
        return;
      }

      onChange(dataUri);
      setMode('idle');
      setCropSrc(null);
      toast.success('Image ready');
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to crop image';
      toast.error(errorMsg);
      setMode('idle');
      setCropSrc(null);
    }
  }, [cropSrc, onChange]);

  const handleUrlFetch = useCallback(async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    if (!trimmed.toLowerCase().startsWith('https://')) {
      toast.error('Only HTTPS URLs are supported');
      return;
    }
    setFetching(true);

    try {
      const res = await api.post('/products/fetch-url', { url: trimmed });
      const dataUri = res.data.data;

      if (!dataUri) {
        toast.error('Could not fetch image from URL');
        return;
      }

      // Load into crop editor
      setCropSrc(dataUri);
      setMode('cropping');
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setUrlInput('');
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      const msg = axiosErr.response?.data?.error || 'Failed to fetch image';
      toast.error(msg);
    } finally {
      setFetching(false);
    }
  }, [urlInput]);

  const handleRemove = useCallback(() => {
    onChange(null);
    setMode('idle');
    setCropSrc(null);
  }, [onChange]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      processFile(acceptedFiles[0]);
    }
  }, [processFile]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/*': [] },
    maxFiles: 1,
    noClick: false,
    noKeyboard: false,
  });

  // ── Crop modal ──────────────────────────────────────────────────────
  if (mode === 'cropping' && cropSrc) {
    return (
      <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl max-w-lg w-full overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <h3 className="font-semibold text-gray-900">{t('products.cropImage')}</h3>
            <button type="button" onClick={() => { setMode('idle'); setCropSrc(null); }} className="text-gray-400 hover:text-gray-600">
              <X size={20} />
            </button>
          </div>
          <div className="relative w-full aspect-square bg-gray-100">
            <Cropper
              image={cropSrc}
              crop={crop}
              zoom={zoom}
              aspect={aspect}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={handleCropComplete}
            />
          </div>
          <div className="px-4 py-3 border-t flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={3}
              step={0.1}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="flex-1"
            />
            <button type="button"
              onClick={handleCropSave}
              className="flex items-center gap-2 px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand/90 transition-colors"
            >
              <Check size={16} />
              Apply
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── URL input mode ──────────────────────────────────────────────────
  if (mode === 'url-input') {
    return (
      <div className="space-y-2">
        <div className="flex gap-2">
          <input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://example.com/photo.jpg"
            className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:border-brand outline-none"
            onKeyDown={(e) => e.key === 'Enter' && handleUrlFetch()}
          />
          <button type="button"
            onClick={handleUrlFetch}
            disabled={fetching || !urlInput.trim()}
            className="px-3 py-2 bg-brand text-white rounded-lg text-sm hover:bg-brand/90 disabled:opacity-50"
          >
            {fetching ? 'Fetching...' : 'Fetch'}
          </button>
          <button type="button"
            onClick={() => { setMode('idle'); setUrlInput(''); }}
            className="px-3 py-2 text-gray-500 hover:text-gray-700 text-sm"
          >
            Cancel
          </button>
        </div>
        <p className="text-xs text-gray-400">Only HTTPS URLs supported. Image will be fetched, cropped, and stored locally.</p>
      </div>
    );
  }

  // ── Idle mode — show current image or upload controls ────────────────
  const previewUrl = value === 'EXISTING' && productId
    ? `${api.defaults.baseURL}/products/${productId}/image?t=${cacheBust}`
    : (value !== 'EXISTING' ? value : null);

  return (
    <div className="space-y-2">
      {/* Current image preview */}
      {previewUrl && (
        <div className="relative w-24 h-24 rounded-lg overflow-hidden border border-gray-200">
          <img src={previewUrl} alt="Product" className="w-full h-full object-cover" />
          <button type="button"
            onClick={handleRemove}
            className="absolute top-1 right-1 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Upload controls */}
      <div className="space-y-3">
        {/* Large File drop zone */}
        <div
          {...getRootProps()}
          className={`w-full flex flex-col items-center justify-center p-6 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${
            isDragActive ? 'border-brand bg-brand/5 text-brand' : 'border-gray-300 text-gray-500 hover:border-brand hover:bg-gray-50'
          }`}
        >
          <input {...getInputProps()} />
          <Upload size={24} className="mb-2 text-gray-400" />
          <p className="text-sm font-medium text-center">
            {isDragActive ? 'Drop image here...' : 'Drag & drop an image here, or click to browse'}
          </p>
        </div>

        <div className="flex items-center gap-2 justify-center">
          <div className="flex-1 h-px bg-gray-200"></div>
          <span className="text-xs text-gray-400 font-medium uppercase px-2">OR USE</span>
          <div className="flex-1 h-px bg-gray-200"></div>
        </div>

        <div className="flex flex-wrap gap-2 justify-center">
          {/* Camera button (tablet POS) */}
          <button type="button"
            onClick={() => cameraInputRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition-colors"
          >
            <Camera size={16} />
            Camera
          </button>
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) processFile(file);
              e.target.value = '';
            }}
          />

          {/* URL paste */}
          <button type="button"
            onClick={() => setMode('url-input')}
            className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition-colors"
          >
            <Link size={16} />
            Paste URL
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-400 text-center mt-4">
        Max {MAX_RAW_FILE_SIZE / 1024 / 1024} MB. Images are compressed to WebP.
      </p>
    </div>
  );
}
