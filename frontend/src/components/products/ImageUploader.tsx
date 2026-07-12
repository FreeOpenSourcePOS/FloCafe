'use client';

import { useCallback, useState, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import Cropper, { type Area } from 'react-easy-crop';
import { Camera, Link, Upload, X, Check } from 'lucide-react';
import { MAX_RAW_FILE_SIZE, MAX_IMAGE_LENGTH } from '@/lib/image-utils';
import api from '@/lib/api';
import toast from 'react-hot-toast';

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
  const [mode, setMode] = useState<Mode>('idle');
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [aspect] = useState(1); // Always 1:1
  const [urlInput, setUrlInput] = useState('');
  const [fetching, setFetching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const cropAreaRef = useRef<{ x: number; y: number; width: number; height: number }>({ x: 0, y: 0, width: 0, height: 0 });

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

    const img = new Image();
    img.src = cropSrc;
    await new Promise<void>((resolve) => { img.onload = () => resolve(); });

    // Use the actual pixel coordinates from react-easy-crop
    const { x, y, width, height } = cropAreaRef.current;

    const TARGET_SIZE = 400; // Fixed max dimension for product images
    const canvas = document.createElement('canvas');
    canvas.width = TARGET_SIZE;
    canvas.height = TARGET_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Draw ONLY the cropped region — scaled down to TARGET_SIZE
    ctx.drawImage(
      img,
      x, y, width, height,   // source: cropped area from original
      0, 0, TARGET_SIZE, TARGET_SIZE // destination: scaled down
    );

    const dataUri = canvas.toDataURL('image/webp', 0.8);

    if (dataUri === 'data:,') {
      toast.error('Failed to process image. Try a different file.');
      setMode('idle');
      setCropSrc(null);
      return;
    }

    if (dataUri.length > MAX_IMAGE_LENGTH) {
      toast.error('Compressed image still too large. Try a simpler image.');
      return;
    }

    onChange(dataUri);
    setMode('idle');
    setCropSrc(null);
    toast.success('Image ready');
  }, [cropSrc, onChange]);

  const handleUrlFetch = useCallback(async () => {
    if (!urlInput.trim()) return;
    setFetching(true);

    try {
      const res = await api.post('/products/fetch-url', { url: urlInput.trim() });
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
            <h3 className="font-semibold text-gray-900">Crop Image</h3>
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
    ? `${api.defaults.baseURL}/products/${productId}/image?t=${Date.now()}`
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
      <div className="flex flex-wrap gap-2">
        {/* File drop zone */}
        <div
          {...getRootProps()}
          className={`flex items-center gap-2 px-3 py-2 border border-dashed rounded-lg text-sm cursor-pointer transition-colors ${
            isDragActive ? 'border-brand bg-brand/5 text-brand' : 'border-gray-200 text-gray-600 hover:border-gray-300'
          }`}
        >
          <input {...getInputProps()} />
          <Upload size={14} />
          {isDragActive ? 'Drop here' : 'Upload'}
        </div>

        {/* Camera button (tablet POS) */}
        <button type="button"
          onClick={() => cameraInputRef.current?.click()}
          className="flex items-center gap-2 px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:border-gray-300"
        >
          <Camera size={14} />
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
          className="flex items-center gap-2 px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:border-gray-300"
        >
          <Link size={14} />
          URL
        </button>
      </div>

      <p className="text-xs text-gray-400">
        Max {MAX_RAW_FILE_SIZE / 1024 / 1024} MB. Images are compressed to WebP and stored in the database.
      </p>
    </div>
  );
}
