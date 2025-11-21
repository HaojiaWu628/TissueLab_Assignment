import asyncio
from pathlib import Path
import json
import logging
from datetime import datetime
from typing import Callable, Optional

from backend.models.schemas import Job, JobType, JobStatus
from backend.models.storage import storage
from backend.services.image_processor import (
    WSIProcessor,
    InstanSegProcessor,
    TissueMaskProcessor
)
from backend.config import settings

logger = logging.getLogger(__name__)


class JobExecutor:

    def __init__(self):
        self.wsi_processor = WSIProcessor()
        self.instanseg = InstanSegProcessor()
        self.tissue_mask = TissueMaskProcessor()
        
        self.progress_callback: Optional[Callable] = None
        
        logger.info("JobExecutor initialized")
    
    def set_progress_callback(self, callback: Callable):
        self.progress_callback = callback
        logger.info("Progress callback set")
    
    async def execute(self, job: Job):
    
        logger.info(f"Executing job {job.id} (type={job.type})")
        
        try:
            if job.type == JobType.SEGMENTATION:
                await self._execute_segmentation(job)
            elif job.type == JobType.TISSUE_MASK:
                await self._execute_tissue_mask(job)
            else:
                raise ValueError(f"Unknown job type: {job.type}")
        except Exception as e:
            logger.error(f"Job {job.id} execution failed: {e}", exc_info=True)
            raise
    
    async def _execute_segmentation(self, job: Job):
        """Execute InstanSeg cell segmentation with optimizations"""
        image_path = job.input_image_path
        
        logger.info(f"Job {job.id}: Loading WSI from {image_path}")
        
        # 1. Load WSI
        slide = await self.wsi_processor.load_wsi(image_path)
        width, height = slide.dimensions
        
        logger.info(f"Job {job.id}: WSI loaded, size={width}x{height}")
        
        # 2. Generate tiles with overlap
        tiles = self.wsi_processor.generate_tiles(width, height)
        logger.info(f"Job {job.id}: Generated {len(tiles)} tiles (with {self.wsi_processor.overlap}px overlap)")
        
        # 3. Filter tissue tiles (optimization - skip background)
        logger.info(f"Job {job.id}: Filtering tissue tiles...")
        tissue_tiles = await self.wsi_processor.filter_tissue_tiles(slide, tiles)
        
        total_tiles = len(tissue_tiles)
        await storage.update_job(job.id, tiles_total=total_tiles)
        await self._notify_progress(job.id)
        
        logger.info(f"Job {job.id}: Processing {total_tiles} tissue tiles (filtered from {len(tiles)} total)")
        
        # 4. Process tiles in batches
        all_results = []
        
        for i in range(0, total_tiles, self.wsi_processor.batch_size):
            batch_tiles = tissue_tiles[i:i + self.wsi_processor.batch_size]
            
            logger.debug(f"Job {job.id}: Processing batch {i//self.wsi_processor.batch_size + 1}")
            
            batch_results = await self.wsi_processor.process_tile_batch(
                slide,
                batch_tiles,
                self.instanseg.segment_tile
            )
            
            all_results.extend(batch_results)
            
            processed = min(i + self.wsi_processor.batch_size, total_tiles)
            progress = (processed / total_tiles) * 100
            
            await storage.update_job(
                job.id,
                progress_percent=progress,
                tiles_processed=processed
            )
            
            # Save intermediate results for in-progress visualization (every 20% or every 10 batches)
            if processed % max(10 * self.wsi_processor.batch_size, int(total_tiles * 0.2)) == 0 or processed == total_tiles:
                await self._save_intermediate_results(job, all_results, width, height)
            
            await self._notify_progress(job.id)
            
            logger.info(f"Job {job.id}: Progress {processed}/{total_tiles} ({progress:.1f}%)")
        
        # 5. Merge overlapping detections (remove duplicates)
        logger.info(f"Job {job.id}: Merging overlapping cell detections...")
        unique_cells = await asyncio.get_event_loop().run_in_executor(
            None,
            self.wsi_processor.merge_overlapping_cells,
            all_results,
            self.wsi_processor.overlap
        )
        
        # 6. Save results with unique cells
        logger.info(f"Job {job.id}: Saving segmentation results ({len(unique_cells)} unique cells)")
        output_path = await self._save_segmentation_results_v2(job, unique_cells, width, height, len(tiles), total_tiles)
        await storage.update_job(
            job.id,
            output_path=output_path,
            status=JobStatus.SUCCEEDED,
            progress_percent=100.0,
            completed_at=datetime.utcnow()
        )
        
        logger.info(f"Job {job.id}: Segmentation completed, output={output_path}")
    
    async def _execute_tissue_mask(self, job: Job):
        """Execute tissue mask generation task"""
        image_path = job.input_image_path
        
        logger.info(f"Job {job.id}: Generating tissue mask for {image_path}")
        
        slide = await self.wsi_processor.load_wsi(image_path)
        width, height = slide.dimensions
        
        tiles = self.wsi_processor.generate_tiles(width, height)
        total_tiles = len(tiles)
        
        await storage.update_job(job.id, tiles_total=total_tiles)
        await self._notify_progress(job.id)
        
        logger.info(f"Job {job.id}: Processing {total_tiles} tiles for tissue mask")
        
        all_results = []
        
        for i in range(0, len(tiles), self.wsi_processor.batch_size):
            batch_tiles = tiles[i:i + self.wsi_processor.batch_size]
            
            batch_results = await self.wsi_processor.process_tile_batch(
                slide,
                batch_tiles,
                self.tissue_mask.generate_mask_tile
            )
            
            all_results.extend(batch_results)
            
            # Update progress
            processed = min(i + self.wsi_processor.batch_size, total_tiles)
            progress = (processed / total_tiles) * 100
            
            await storage.update_job(
                job.id,
                progress_percent=progress,
                tiles_processed=processed
            )
            
            await self._notify_progress(job.id)
        

        logger.info(f"Job {job.id}: Saving tissue mask results")
        output_path = await self._save_mask_results(job, all_results, width, height)
        await storage.update_job(
            job.id,
            output_path=output_path,
            status=JobStatus.SUCCEEDED,
            progress_percent=100.0,
            completed_at=datetime.utcnow()
        )
        
        logger.info(f"Job {job.id}: Tissue mask completed")
    
    async def _save_segmentation_results(self, job: Job, results: list, image_width: int, image_height: int) -> str:
        """Save segmentation results as JSON"""
        output_dir = Path(settings.RESULT_DIR) / job.workflow_id
        output_dir.mkdir(parents=True, exist_ok=True)
        
        output_file = output_dir / f"{job.id}_segmentation.json"
        
        all_cells = []
        cell_id = 1
        for result in results:
            for cell in result['cells']:
                cell['global_id'] = cell_id
                all_cells.append(cell)
                cell_id += 1
        
        output_data = {
            'job_id': job.id,
            'workflow_id': job.workflow_id,
            'branch_id': job.branch_id,
            'type': 'segmentation',
            'timestamp': datetime.utcnow().isoformat(),
            'image_dimensions': {
                'width': image_width,
                'height': image_height
            },
            'total_cells': len(all_cells),
            'total_tiles': len(results),
            'cells': all_cells,
            'metadata': {
                'tile_size': self.wsi_processor.tile_size,
                'overlap': self.wsi_processor.overlap
            }
        }
        
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None,
            lambda: output_file.write_text(json.dumps(output_data, indent=2))
        )
        
        logger.info(f"Saved {len(all_cells)} cells to {output_file}")
        return str(output_file)
    
    async def _save_segmentation_results_v2(self, job: Job, cells: list, image_width: int, image_height: int, 
                                           total_tiles: int, tissue_tiles: int) -> str:
        """
        Save segmentation results with enhanced statistics
        
        This version includes detailed statistics and optimizations info
        """
        output_dir = Path(settings.RESULT_DIR) / job.workflow_id
        output_dir.mkdir(parents=True, exist_ok=True)
        
        output_file = output_dir / f"{job.id}_segmentation.json"
        
        # Assign global IDs to cells
        for i, cell in enumerate(cells, 1):
            cell['global_id'] = i
        
        # Calculate statistics
        total_area = sum(cell['area'] for cell in cells)
        avg_area = total_area / len(cells) if cells else 0
        image_area_megapixels = (image_width * image_height) / 1e6
        
        output_data = {
            'job_id': job.id,
            'workflow_id': job.workflow_id,
            'branch_id': job.branch_id,
            'type': 'segmentation_optimized',
            'timestamp': datetime.utcnow().isoformat(),
            'image_dimensions': {
                'width': image_width,
                'height': image_height,
                'area_megapixels': round(image_area_megapixels, 2)
            },
            'statistics': {
                'total_cells': len(cells),
                'total_cell_area': round(total_area, 2),
                'average_cell_area': round(avg_area, 2),
                'cell_density_per_megapixel': round(len(cells) / image_area_megapixels, 2) if image_area_megapixels > 0 else 0,
                'tissue_coverage': round((tissue_tiles / total_tiles * 100), 2) if total_tiles > 0 else 0
            },
            'processing_info': {
                'tile_size': self.wsi_processor.tile_size,
                'overlap': self.wsi_processor.overlap,
                'batch_size': self.wsi_processor.batch_size,
                'total_tiles_generated': total_tiles,
                'tissue_tiles_processed': tissue_tiles,
                'tiles_skipped': total_tiles - tissue_tiles,
                'optimization_ratio': round((total_tiles - tissue_tiles) / total_tiles * 100, 2) if total_tiles > 0 else 0
            },
            'cells': cells
        }
        
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None,
            lambda: output_file.write_text(json.dumps(output_data, indent=2))
        )
        
        logger.info(f"Saved {len(cells)} unique cells to {output_file} (skipped {total_tiles - tissue_tiles} background tiles)")
        
        # Generate visualization image with original WSI
        try:
            from backend.services.image_processor import generate_visualization_image
            
            # Add image_size to processing_info for visualization
            output_data['processing_info']['image_size'] = {
                'width': image_width,
                'height': image_height
            }
            
            viz_file = output_dir / f"{job.id}_visualization.png"
            thumb_file = output_dir / f"{job.id}_thumbnail.png"
            
            # Pass original image path for WSI background
            viz_info = await loop.run_in_executor(
                None,
                generate_visualization_image,
                output_data,
                viz_file,
                thumb_file,
                job.input_image_path  # Pass original WSI path
            )
            
            if viz_info.get('visualization_path'):
                logger.info(f"Generated visualization with original WSI: {viz_info['visualization_path']}")
                # Update output_data with visualization paths
                output_data['visualization'] = viz_info
                # Re-save JSON with visualization info
                await loop.run_in_executor(
                    None,
                    lambda: output_file.write_text(json.dumps(output_data, indent=2))
                )
        except Exception as e:
            logger.warning(f"Failed to generate visualization (non-critical): {e}")
        
        return str(output_file)
    
    async def _save_mask_results(self, job: Job, results: list, image_width: int, image_height: int) -> str:
        """Save mask results"""
        output_dir = Path(settings.RESULT_DIR) / job.workflow_id
        output_dir.mkdir(parents=True, exist_ok=True)
        
        output_file = output_dir / f"{job.id}_tissue_mask.json"
        
        tissue_tiles = [r for r in results if r['has_tissue']]
        
        output_data = {
            'job_id': job.id,
            'workflow_id': job.workflow_id,
            'branch_id': job.branch_id,
            'type': 'tissue_mask',
            'timestamp': datetime.utcnow().isoformat(),
            'image_dimensions': {
                'width': image_width,
                'height': image_height
            },
            'total_tiles': len(results),
            'tissue_tiles': len(tissue_tiles),
            'tissue_coverage': len(tissue_tiles) / len(results) * 100,
            'tiles': results,
            'metadata': {
                'tile_size': self.wsi_processor.tile_size,
                'overlap': self.wsi_processor.overlap
            }
        }
        
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None,
            lambda: output_file.write_text(json.dumps(output_data, indent=2))
        )
        
        logger.info(f"Saved tissue mask ({len(tissue_tiles)}/{len(results)} tiles) to {output_file}")
        return str(output_file)
    
    async def _save_intermediate_results(self, job: Job, results: list, image_width: int, image_height: int):
        """
        Save intermediate segmentation results for in-progress visualization
        
        This allows users to view already-processed cells while job is still running
        """
        try:
            output_dir = Path(settings.RESULT_DIR) / job.workflow_id
            output_dir.mkdir(parents=True, exist_ok=True)
            
            # Collect all cells from current results
            all_cells = []
            for result in results:
                for cell in result['cells']:
                    all_cells.append(cell)
            
            # Assign IDs
            for i, cell in enumerate(all_cells, 1):
                cell['global_id'] = i
            
            # Create intermediate data structure
            intermediate_data = {
                'job_id': job.id,
                'workflow_id': job.workflow_id,
                'type': 'segmentation_in_progress',
                'timestamp': datetime.utcnow().isoformat(),
                'progress_percent': job.progress_percent,
                'tiles_processed': job.tiles_processed,
                'tiles_total': job.tiles_total,
                'image_dimensions': {
                    'width': image_width,
                    'height': image_height
                },
                'statistics': {
                    'cells_so_far': len(all_cells),
                    'tiles_processed': len(results)
                },
                'processing_info': {
                    'image_size': {
                        'width': image_width,
                        'height': image_height
                    }
                },
                'cells': all_cells
            }
            
            # Save intermediate JSON
            intermediate_file = output_dir / f"{job.id}_intermediate.json"
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                lambda: intermediate_file.write_text(json.dumps(intermediate_data, indent=2))
            )
            
            # Generate intermediate visualization
            from backend.services.image_processor import generate_visualization_image
            
            viz_file = output_dir / f"{job.id}_intermediate_visualization.png"
            thumb_file = output_dir / f"{job.id}_intermediate_thumbnail.png"
            
            viz_info = await loop.run_in_executor(
                None,
                generate_visualization_image,
                intermediate_data,
                viz_file,
                thumb_file,
                job.input_image_path
            )
            
            logger.info(f"Saved intermediate results: {len(all_cells)} cells from {len(results)} tiles ({job.progress_percent:.1f}% complete)")
            
        except Exception as e:
            logger.warning(f"Failed to save intermediate results (non-critical): {e}")
    
    async def _notify_progress(self, job_id: str):
        """Notify progress via callback"""
        if self.progress_callback:
            job = await storage.get_job(job_id)
            if job:
                try:
                    logger.debug(f"Notifying progress for job {job_id}: {job.progress_percent:.1f}%")
                    await self.progress_callback(job)
                except Exception as e:
                    logger.error(f"Progress callback error: {e}")


job_executor = JobExecutor()