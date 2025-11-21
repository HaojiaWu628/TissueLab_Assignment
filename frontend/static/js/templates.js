// ============================================
// DAG Templates for Quick Start
// ============================================

function getExampleDAGs() {
    return {
        simple: {
            branches: {
                "main": [
                    {
                        type: "SEGMENTATION",
                        input_image_path: "/data/uploads/sample.svs",
                        params: {}
                    }
                ]
            }
        },
        
        sequential: {
            branches: {
                "preprocessing": [
                    {
                        type: "TISSUE_MASK",
                        input_image_path: "/data/uploads/sample.svs",
                        params: {}
                    }
                ],
                "analysis": [
                    {
                        type: "SEGMENTATION",
                        input_image_path: "/data/uploads/sample.svs",
                        params: {}
                    }
                ]
            }
        },
        
        parallel: {
            branches: {
                "branch_1": [
                    {
                        type: "TISSUE_MASK",
                        input_image_path: "/data/uploads/image1.svs",
                        params: {}
                    },
                    {
                        type: "SEGMENTATION",
                        input_image_path: "/data/uploads/image1.svs",
                        params: {}
                    }
                ],
                "branch_2": [
                    {
                        type: "TISSUE_MASK",
                        input_image_path: "/data/uploads/image2.svs",
                        params: {}
                    },
                    {
                        type: "SEGMENTATION",
                        input_image_path: "/data/uploads/image2.svs",
                        params: {}
                    }
                ],
                "branch_3": [
                    {
                        type: "SEGMENTATION",
                        input_image_path: "/data/uploads/image3.svs",
                        params: {}
                    }
                ]
            }
        }
    };
}

function loadTemplate(templateName) {
    const templates = {
        'single-segmentation': {
            name: "Single Image Segmentation",
            dag: {
                branches: {
                    "main": [
                        {
                            type: "SEGMENTATION",
                            input_image_path: "/data/uploads/sample.svs",
                            params: {
                                model: "fluorescence_nuclei_with_overlap",
                                batch_size: 4
                            }
                        }
                    ]
                }
            }
        },
        
        'tissue-then-segment': {
            name: "Tissue Mask Then Segmentation",
            dag: {
                branches: {
                    "preprocessing": [
                        {
                            type: "TISSUE_MASK",
                            input_image_path: "/data/uploads/sample.svs",
                            params: {
                                threshold: 0.5
                            }
                        }
                    ],
                    "segmentation": [
                        {
                            type: "SEGMENTATION",
                            input_image_path: "/data/uploads/sample.svs",
                            params: {
                                use_tissue_mask: true
                            }
                        }
                    ]
                }
            }
        },
        
        'parallel-branches': {
            name: "Parallel Multi-Branch Processing",
            dag: {
                branches: {
                    "image_1_pipeline": [
                        {
                            type: "TISSUE_MASK",
                            input_image_path: "/data/uploads/image1.svs",
                            params: {}
                        },
                        {
                            type: "SEGMENTATION",
                            input_image_path: "/data/uploads/image1.svs",
                            params: {}
                        }
                    ],
                    "image_2_pipeline": [
                        {
                            type: "TISSUE_MASK",
                            input_image_path: "/data/uploads/image2.svs",
                            params: {}
                        },
                        {
                            type: "SEGMENTATION",
                            input_image_path: "/data/uploads/image2.svs",
                            params: {}
                        }
                    ],
                    "image_3_quick": [
                        {
                            type: "SEGMENTATION",
                            input_image_path: "/data/uploads/image3.svs",
                            params: {}
                        }
                    ]
                }
            }
        },
        
        'custom': {
            name: "Custom Workflow",
            dag: {
                branches: {
                    "branch_1": [
                        {
                            type: "SEGMENTATION",
                            input_image_path: "/data/uploads/your_image.svs",
                            params: {}
                        }
                    ]
                }
            }
        }
    };
    
    const template = templates[templateName];
    if (template) {
        document.getElementById('workflowName').value = template.name;
        document.getElementById('dagJson').value = JSON.stringify(template.dag, null, 2);
        
        // Trigger preview
        previewDAG();
        
        // Scroll to form
        document.getElementById('workflowForm').scrollIntoView({ behavior: 'smooth' });
        
        showToast(`Template "${template.name}" loaded`, 'info');
    }
}

// ============================================
// Example Workflow Scenarios
// ============================================

function getWorkflowExamples() {
    return [
        {
            title: "Basic Cell Segmentation",
            description: "Process a single WSI for cell segmentation",
            branches: 1,
            jobs: 1,
            estimatedTime: "5-10 minutes",
            dag: {
                branches: {
                    "main": [
                        {
                            type: "SEGMENTATION",
                            input_image_path: "/data/uploads/sample.svs",
                            params: {}
                        }
                    ]
                }
            }
        },
        {
            title: "Two-Stage Analysis",
            description: "Generate tissue mask, then perform segmentation",
            branches: 2,
            jobs: 2,
            estimatedTime: "8-15 minutes",
            dag: {
                branches: {
                    "stage_1": [
                        {
                            type: "TISSUE_MASK",
                            input_image_path: "/data/uploads/sample.svs",
                            params: {}
                        }
                    ],
                    "stage_2": [
                        {
                            type: "SEGMENTATION",
                            input_image_path: "/data/uploads/sample.svs",
                            params: {}
                        }
                    ]
                }
            }
        },
        {
            title: "Batch Processing (3 images)",
            description: "Process multiple images in parallel",
            branches: 3,
            jobs: 3,
            estimatedTime: "10-20 minutes",
            dag: {
                branches: {
                    "image_1": [
                        {
                            type: "SEGMENTATION",
                            input_image_path: "/data/uploads/image1.svs",
                            params: {}
                        }
                    ],
                    "image_2": [
                        {
                            type: "SEGMENTATION",
                            input_image_path: "/data/uploads/image2.svs",
                            params: {}
                        }
                    ],
                    "image_3": [
                        {
                            type: "SEGMENTATION",
                            input_image_path: "/data/uploads/image3.svs",
                            params: {}
                        }
                    ]
                }
            }
        },
        {
            title: "Complex Pipeline",
            description: "Multi-stage processing with parallel branches",
            branches: 4,
            jobs: 8,
            estimatedTime: "20-40 minutes",
            dag: {
                branches: {
                    "prep_A": [
                        {
                            type: "TISSUE_MASK",
                            input_image_path: "/data/uploads/imageA.svs",
                            params: {}
                        },
                        {
                            type: "SEGMENTATION",
                            input_image_path: "/data/uploads/imageA.svs",
                            params: {}
                        }
                    ],
                    "prep_B": [
                        {
                            type: "TISSUE_MASK",
                            input_image_path: "/data/uploads/imageB.svs",
                            params: {}
                        },
                        {
                            type: "SEGMENTATION",
                            input_image_path: "/data/uploads/imageB.svs",
                            params: {}
                        }
                    ],
                    "quick_C": [
                        {
                            type: "SEGMENTATION",
                            input_image_path: "/data/uploads/imageC.svs",
                            params: {}
                        }
                    ],
                    "quick_D": [
                        {
                            type: "SEGMENTATION",
                            input_image_path: "/data/uploads/imageD.svs",
                            params: {}
                        }
                    ]
                }
            }
        }
    ];
}

// ============================================
// Job Type Descriptions
// ============================================

function getJobTypeInfo() {
    return {
        SEGMENTATION: {
            name: "Cell Segmentation",
            icon: "fa-microscope",
            description: "Segment individual cells using InstanSeg deep learning model",
            inputs: ["WSI image path"],
            outputs: ["Cell boundaries (polygons)", "Cell metadata (area, centroid)", "Segmentation mask"],
            estimatedTime: "5-10 minutes per WSI",
            parameters: {
                model: "InstanSeg model variant (default: fluorescence_nuclei_with_overlap)",
                tile_size: "Processing tile size (default: 1024)",
                overlap: "Tile overlap for seamless merging (default: 128)",
                batch_size: "Number of tiles to process simultaneously (default: 4)"
            }
        },
        TISSUE_MASK: {
            name: "Tissue Mask Generation",
            icon: "fa-layer-group",
            description: "Generate binary mask to identify tissue regions vs background",
            inputs: ["WSI image path"],
            outputs: ["Tissue mask image", "Tissue coverage statistics", "Tissue tile coordinates"],
            estimatedTime: "3-5 minutes per WSI",
            parameters: {
                threshold: "Tissue detection threshold (0.0-1.0, default: 0.5)",
                min_tissue_area: "Minimum tissue area to consider (pixels, default: 1000)"
            }
        }
    };
}

