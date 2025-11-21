# backend/services/image_processor.py
import asyncio
import numpy as np
from pathlib import Path
from typing import List, Optional, Dict, Any
import logging
import json
from PIL import Image, ImageDraw
import torch

from backend.config import settings

# Import required libraries - no mock fallback
import openslide
from instanseg import InstanSeg
from skimage.measure import regionprops, label
from skimage.filters import threshold_otsu

logger = logging.getLogger(__name__)
logger.info("Real InstanSeg processing enabled - Mock mode removed")


class TileCoordinate:
    """Coordinates of a tile"""

    def __init__(self, x: int, y: int, width: int, height: int, level: int = 0):
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.level = level
    
    def __repr__(self):
        return f"Tile(x={self.x}, y={self.y}, w={self.width}, h={self.height})"


# Mock mode completely removed - always use real OpenSlide


class WSIProcessor:
    """
    WSI (Whole Slide Image) Processor

    Responsibilities:
    1. Tile generation with overlap
    2. Batch tile extraction and processing
    3. (Optional) Tile merging / blending
    """

    def __init__(
        self,
        tile_size: int = None,
        overlap: int = None,
        batch_size: int = None
    ):
        self.tile_size = tile_size or settings.TILE_SIZE
        self.overlap = overlap or settings.TILE_OVERLAP
        self.batch_size = batch_size or settings.BATCH_SIZE
        
        logger.info(
            f"WSIProcessor initialized: tile={self.tile_size}, "
            f"overlap={self.overlap}, batch={self.batch_size}"
        )
    
    def generate_tiles(
        self,
        image_width: int,
        image_height: int,
        level: int = 0
    ) -> List[TileCoordinate]:
        """
        Generate a list of tile coordinates (with overlap)
        """
        tiles = []
        stride = self.tile_size - self.overlap
        
        y = 0
        while y < image_height:
            x = 0
            while x < image_width:
                actual_width = min(self.tile_size, image_width - x)
                actual_height = min(self.tile_size, image_height - y)
                
                tiles.append(TileCoordinate(x, y, actual_width, actual_height, level))
                
                x += stride
                if x >= image_width:
                    break
            
            y += stride
            if y >= image_height:
                break
        
        logger.info(f"Generated {len(tiles)} tiles ({image_width}x{image_height}, stride={stride})")
        return tiles
    
    async def load_wsi(self, image_path: str):
        """Load WSI image using OpenSlide"""
        loop = asyncio.get_event_loop()
        slide = await loop.run_in_executor(None, openslide.OpenSlide, image_path)
        logger.info(f"Loaded WSI: {image_path}, size={slide.dimensions}")
        return slide
    
    async def extract_tile(self, slide, tile: TileCoordinate) -> np.ndarray:
        """Extract a single tile from OpenSlide"""
        loop = asyncio.get_event_loop()
        pil_image = await loop.run_in_executor(
            None,
            lambda: slide.read_region((tile.x, tile.y), tile.level, (tile.width, tile.height))
        )
        # Convert RGBA to RGB
        tile_image = np.array(pil_image.convert('RGB'))
        return tile_image
    
    async def process_tile_batch(
        self,
        slide,
        tiles: List[TileCoordinate],
        processor_func
    ) -> List[dict]:
        """
        Process a batch of tiles
        
        Args:
            slide: OpenSlide WSI object
            tiles: list of tile coordinates
            processor_func: function(tile_image, tile) -> dict
        
        Returns:
            List[dict]: processed tile results
        """
        results = []
        
        for tile in tiles:
            tile_image = await self.extract_tile(slide, tile)
            
            # Simulate computation time
            await asyncio.sleep(0.05)
            result = processor_func(tile_image, tile)
            
            results.append(result)
        
        return results
    
    async def filter_tissue_tiles(self, slide, tiles: List[TileCoordinate], threshold: float = 0.1) -> List[TileCoordinate]:
        """
        Filter out tiles that don't contain enough tissue (optimization)
        
        Quick tissue detection to skip background tiles
        
        Args:
            slide: OpenSlide WSI object
            tiles: List of tile coordinates
            threshold: Minimum tissue ratio (default 0.1 = 10%)
        
        Returns:
            List of tiles that contain tissue
        """
        tissue_tiles = []
        
        for tile in tiles:
            try:
                # Use lower level (4x downsampled) for speed
                check_level = min(2, slide.level_count - 1)
                downsample = slide.level_downsamples[check_level]
                
                small_size = (max(1, int(tile.width / downsample)), max(1, int(tile.height / downsample)))
                pil_image = slide.read_region((tile.x, tile.y), check_level, small_size)
                tile_image = np.array(pil_image.convert('RGB'))
                
                # Simple tissue detection: check if not mostly white background
                mean_intensity = np.mean(tile_image)
                if mean_intensity < 200:  # Not background
                    tissue_tiles.append(tile)
            except Exception:
                # If fails, assume it has tissue
                tissue_tiles.append(tile)
        
        logger.info(f"Filtered tiles: {len(tiles)} -> {len(tissue_tiles)} tissue-containing tiles ({len(tissue_tiles)/len(tiles)*100:.1f}% kept)")
        return tissue_tiles
    
    def merge_overlapping_cells(self, all_results: List[dict], overlap: int) -> List[dict]:
        """
        Merge cells detected in overlapping regions to avoid duplicates
        
        Uses centroid distance to identify duplicates in overlap zones.
        This implements the "blending/merging" hint from the requirements.
        
        Args:
            all_results: List of tile results, each containing detected cells
            overlap: Overlap distance in pixels
        
        Returns:
            List of unique cells with duplicates removed
        """
        if not all_results:
            return []
        
        # Flatten all cells with their tile info
        all_cells = []
        for result in all_results:
            tile_info = result.get('tile', {})
            for cell in result.get('cells', []):
                cell_with_tile = cell.copy()
                cell_with_tile['tile_bounds'] = {
                    'x_min': tile_info.get('x', 0),
                    'x_max': tile_info.get('x', 0) + tile_info.get('width', 0),
                    'y_min': tile_info.get('y', 0),
                    'y_max': tile_info.get('y', 0) + tile_info.get('height', 0)
                }
                all_cells.append(cell_with_tile)
        
        if not all_cells:
            return []
        
        # Sort by centroid position for efficient processing
        all_cells.sort(key=lambda c: (c['centroid'][1], c['centroid'][0]))
        
        # Remove duplicates using distance threshold
        unique_cells = []
        duplicate_threshold = overlap / 2  # Half overlap distance as threshold
        
        for cell in all_cells:
            is_duplicate = False
            cx, cy = cell['centroid']
            
            # Check against already accepted cells (only nearby ones for efficiency)
            for unique_cell in unique_cells:
                ux, uy = unique_cell['centroid']
                
                # Quick bounding box check first
                if abs(cx - ux) > duplicate_threshold and abs(cy - uy) > duplicate_threshold:
                    continue
                
                # Calculate actual distance
                distance = np.sqrt((cx - ux)**2 + (cy - uy)**2)
                
                if distance < duplicate_threshold:
                    # This is likely a duplicate from overlap region
                    # Keep the one with larger area (better detection quality)
                    if cell['area'] <= unique_cell['area']:
                        is_duplicate = True
                        break
                    else:
                        # Replace the existing one with this better detection
                        unique_cells.remove(unique_cell)
                        break
            
            if not is_duplicate:
                # Remove tile_bounds before adding (not needed in final output)
                if 'tile_bounds' in cell:
                    del cell['tile_bounds']
                unique_cells.append(cell)
        
        logger.info(f"Merged cells: {len(all_cells)} -> {len(unique_cells)} unique cells (removed {len(all_cells) - len(unique_cells)} duplicates, {(len(all_cells) - len(unique_cells))/len(all_cells)*100:.1f}%)")
        
        return unique_cells


class InstanSegProcessor:
    """
    InstanSeg Processor - Real AI-powered cell segmentation
    """

    def __init__(self):
        self.model = None
        logger.info("InstanSegProcessor initialized - Real InstanSeg mode only")
    
    def _load_model(self):
        """Lazy load InstanSeg model"""
        if self.model is None:
                logger.info(f"Loading InstanSeg model: {settings.INSTANSEG_MODEL}")
                self.model = InstanSeg(settings.INSTANSEG_MODEL)
                logger.info("InstanSeg model loaded successfully")
    
    def segment_tile(self, tile_image: np.ndarray, tile: TileCoordinate) -> dict:
        """Segment cells in a tile using Real InstanSeg"""
        self._load_model()
        return self._segment_real(tile_image, tile)
    
    def _segment_real(self, tile_image: np.ndarray, tile: TileCoordinate) -> dict:
        """Real InstanSeg processing"""
        # Ensure RGB format and numpy array
        if not isinstance(tile_image, np.ndarray):
            tile_image = np.array(tile_image)
        
        if len(tile_image.shape) == 2:
            tile_image = np.stack([tile_image] * 3, axis=-1)
        
        # Ensure correct data type
        if tile_image.dtype != np.uint8:
            tile_image = tile_image.astype(np.uint8)
        
        # Run InstanSeg
        result = self.model.eval_small_image(tile_image)
        
        # InstanSeg returns a tuple: (labeled_masks, pixel_embeddings)
        # Extract the mask tensor (first element)
        if isinstance(result, tuple):
            mask_tensor = result[0]
        else:
            mask_tensor = result
        
        # Convert torch tensor to numpy and remove batch/channel dimensions
        import torch
        if isinstance(mask_tensor, torch.Tensor):
            segmentation_mask = mask_tensor.cpu().numpy()
            # Remove batch and channel dimensions: [1, 1, H, W] -> [H, W]
            if segmentation_mask.ndim == 4:
                segmentation_mask = segmentation_mask[0, 0]
            elif segmentation_mask.ndim == 3:
                segmentation_mask = segmentation_mask[0]
        else:
            segmentation_mask = np.array(mask_tensor)
        
        # Parse results
        labeled_mask = label(segmentation_mask)
        regions = regionprops(labeled_mask)
        
        cells = []
        for i, region in enumerate(regions):
            # Extract contour points (sample every 5th point to reduce size)
            coords = region.coords
            polygon = []
            for y, x in coords[::5]:
                polygon.append([float(tile.x + x), float(tile.y + y)])
            
            # Cell properties
            centroid_y, centroid_x = region.centroid
            
            cells.append({
                'id': i + 1,
                'polygon': polygon,
                'centroid': [float(tile.x + centroid_x), float(tile.y + centroid_y)],
                'area': float(region.area),
                'confidence': 1.0  # InstanSeg doesn't provide confidence scores
            })
        
        logger.debug(f"Real segmentation: {len(cells)} cells in tile ({tile.x},{tile.y})")
        
        return {
            'tile': {'x': tile.x, 'y': tile.y, 'width': tile.width, 'height': tile.height},
            'cells': cells,
            'cell_count': len(cells)
        }
    
# Mock mode completely removed - always use real InstanSeg


class TissueMaskProcessor:
    """Tissue mask generator using Otsu thresholding"""

    def __init__(self):
        logger.info("TissueMaskProcessor initialized (Otsu thresholding)")
    
    def generate_mask_tile(self, tile_image: np.ndarray, tile: TileCoordinate) -> dict:
        """Generate tissue mask for a tile using Otsu threshold"""
        # Convert to grayscale
        gray = np.mean(tile_image, axis=2) if len(tile_image.shape) == 3 else tile_image
        
        # Use Otsu thresholding
        threshold = threshold_otsu(gray)
        logger.debug(f"Otsu threshold: {threshold:.1f}")
        
        # Generate mask
        tissue_mask = gray < threshold
        tissue_ratio = np.sum(tissue_mask) / tissue_mask.size
        has_tissue = tissue_ratio > 0.1
        
        return {
            'tile': {
                'x': tile.x,
                'y': tile.y,
                'width': tile.width,
                'height': tile.height
            },
            'has_tissue': bool(has_tissue),
            'tissue_ratio': float(tissue_ratio),
            'mean_intensity': float(np.mean(gray)),
            'threshold': float(threshold)
        }


def generate_visualization_image(
    result_data: Dict[Any, Any],
    output_path: Path,
    thumbnail_path: Optional[Path] = None,
    original_image_path: Optional[str] = None,
    max_dimension: int = 2048
) -> Dict[str, Any]:
    """
    Generate visualization image with cell segmentation overlay on ORIGINAL WSI image
    
    Per requirements: Display the original WSI image with cell segmentation overlay
    
    Args:
        result_data: Segmentation result data with cells
        output_path: Path to save full visualization (overlay only)
        thumbnail_path: Optional path for thumbnail
        original_image_path: Path to original WSI file
        max_dimension: Maximum dimension for full image
        
    Returns:
        Dict with visualization info
    """
    try:
        logger.info(f"Generating visualization image: {output_path}")
        
        # Extract dimensions and cells
        if 'processing_info' in result_data and 'image_size' in result_data['processing_info']:
            width = result_data['processing_info']['image_size'].get('width', 4096)
            height = result_data['processing_info']['image_size'].get('height', 4096)
        else:
            width = 4096
            height = 4096
        
        cells = result_data.get('cells', [])
        
        # Calculate scale factor to fit max dimension
        scale = min(max_dimension / width, max_dimension / height, 1.0)
        scaled_width = int(width * scale)
        scaled_height = int(height * scale)
        
        # ===== Generate Original WSI Background Image =====
        base_img = None
        if original_image_path and Path(original_image_path).exists():
            try:
                # Load WSI and create downsampled version
                logger.info(f"Loading original WSI for visualization: {original_image_path}")
                slide = openslide.OpenSlide(original_image_path)
                
                # Find appropriate level for visualization
                best_level = 0
                for level in range(slide.level_count):
                    level_dims = slide.level_dimensions[level]
                    if level_dims[0] <= scaled_width * 1.5 and level_dims[1] <= scaled_height * 1.5:
                        best_level = level
                        break
                
                # Read at appropriate level
                level_dims = slide.level_dimensions[best_level]
                logger.info(f"Reading WSI at level {best_level}, dimensions: {level_dims}")
                wsi_img = slide.read_region((0, 0), best_level, level_dims)
                base_img = wsi_img.convert('RGB')
                
                # Resize to target dimensions
                if base_img.size != (scaled_width, scaled_height):
                    base_img = base_img.resize((scaled_width, scaled_height), Image.Resampling.LANCZOS)
                
                logger.info(f"WSI background loaded successfully: {base_img.size}")
                slide.close()
            except Exception as e:
                logger.warning(f"Failed to load original WSI for visualization: {e}")
        
        # If no original image available, create placeholder
        if base_img is None:
            logger.info("Creating placeholder background (original WSI not available)")
            base_img = Image.new('RGB', (scaled_width, scaled_height), (240, 240, 240))
        
        # ===== Generate Overlay Layer (transparent PNG with cells) =====
        overlay = Image.new('RGBA', (scaled_width, scaled_height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        
        # Draw cells
        logger.info(f"Drawing {len(cells)} cells on {scaled_width}x{scaled_height} canvas")
        
        for i, cell in enumerate(cells):
            if 'polygon' not in cell:
                continue
            
            # Scale polygon coordinates
            polygon = [(x * scale, y * scale) for x, y in cell['polygon']]
            
            # Different colors based on confidence or cell type
            confidence = cell.get('confidence', 0.9)
            if confidence > 0.95:
                color = (0, 255, 0, 120)  # High confidence - Green with transparency
            elif confidence > 0.85:
                color = (255, 165, 0, 120)  # Medium - Orange
            else:
                color = (255, 0, 0, 120)  # Low confidence - Red
            
            # Draw filled polygon with transparency and boundary
            draw.polygon(polygon, fill=color, outline=(255, 255, 255, 200), width=2)
        
        # ===== Create Combined Image (WSI + Overlay) =====
        combined_img = base_img.copy()
        combined_img.paste(overlay, (0, 0), overlay)  # Paste overlay with alpha channel
        
        # Add statistics overlay
        stats = result_data.get('statistics', {})
        total_cells = stats.get('total_cells', len(cells))
        
        # Draw info box on combined image
        draw_combined = ImageDraw.Draw(combined_img)
        info_text = [
            f"Total Cells: {total_cells}",
            f"Image: {width}x{height}",
        ]
        
        if 'cell_density_per_megapixel' in stats:
            info_text.append(f"Density: {stats['cell_density_per_megapixel']:.1f} cells/MP")
        
        # Draw semi-transparent info box
        box_height = len(info_text) * 25 + 20
        info_overlay = Image.new('RGBA', (scaled_width, scaled_height), (0, 0, 0, 0))
        info_draw = ImageDraw.Draw(info_overlay)
        info_draw.rectangle([(10, 10), (300, box_height)], fill=(255, 255, 255, 220))
        
        # Draw text
        y_offset = 20
        for text in info_text:
            info_draw.text((20, y_offset), text, fill=(0, 0, 0, 255))
            y_offset += 25
        
        combined_img.paste(info_overlay, (0, 0), info_overlay)
        
        # ===== Save Images =====
        output_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Save combined visualization (WSI + overlay)
        combined_img.save(output_path, 'PNG')
        logger.info(f"Saved combined visualization: {output_path}")
        
        # Save overlay-only (for toggle functionality)
        overlay_only_path = output_path.parent / f"{output_path.stem}_overlay_only.png"
        overlay.save(overlay_only_path, 'PNG')
        logger.info(f"Saved overlay-only: {overlay_only_path}")
        
        # Save original WSI base (for toggle functionality)
        wsi_base_path = output_path.parent / f"{output_path.stem}_wsi_base.png"
        base_img.save(wsi_base_path, 'PNG')
        logger.info(f"Saved WSI base: {wsi_base_path}")
        
        # Generate thumbnail if requested
        thumbnail_size = None
        if thumbnail_path:
            thumb_scale = min(512 / width, 512 / height)
            thumb_width = int(width * thumb_scale)
            thumb_height = int(height * thumb_scale)
            thumbnail = combined_img.resize((thumb_width, thumb_height), Image.Resampling.LANCZOS)
            thumbnail_path.parent.mkdir(parents=True, exist_ok=True)
            thumbnail.save(thumbnail_path, 'PNG')
            thumbnail_size = {'width': thumb_width, 'height': thumb_height}
            logger.info(f"Saved thumbnail: {thumbnail_path}")
        
        return {
            'visualization_path': str(output_path),
            'overlay_only_path': str(overlay_only_path),
            'wsi_base_path': str(wsi_base_path),
            'thumbnail_path': str(thumbnail_path) if thumbnail_path else None,
            'image_size': {'width': scaled_width, 'height': scaled_height},
            'thumbnail_size': thumbnail_size,
            'cells_drawn': len(cells),
            'has_original_wsi': base_img is not None
        }
        
    except Exception as e:
        logger.error(f"Failed to generate visualization: {e}", exc_info=True)
        return {
            'error': str(e),
            'visualization_path': None
        }
