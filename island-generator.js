import * as THREE from 'three';
import { calculateIslandHeight, createIslandMesh } from './island-geometry.js';

export class IslandGenerator {
    constructor(scene) {
        this.scene = scene;
        this.mesh = null;
        this.center = new THREE.Vector3(0, 1, 0); // Target center direction on Earth
        this.state = 'inactive'; // inactive, spawning, docked
        this.progress = 0; // 0 to 1
        this.baseRadius = 10; // Fixed base radius for generation to ensure consistent noise features
        
        // Reusable vectors for physics to avoid garbage
        this._localDir = new THREE.Vector3();
        this._dummyQ = new THREE.Quaternion();

        // Sand Simulation (RTT)
        this.simRes = 512; // Higher res for particle detail
        this.simScene = new THREE.Scene();
        this.simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.rtA = new THREE.WebGLRenderTarget(this.simRes, this.simRes, { 
            minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.FloatType 
        });
        this.rtB = new THREE.WebGLRenderTarget(this.simRes, this.simRes, { 
            minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.FloatType 
        });
        this.currentRt = this.rtA;
        this.prevRt = this.rtB;
        
        // Sim Shader Material
        this.simMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uPrev: { value: null },
                uSnakeUV: { value: new THREE.Vector2(-1, -1) },
                uBrushSize: { value: 0.05 },
                uTime: { value: 0 }
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D uPrev;
                uniform vec2 uSnakeUV;
                uniform float uBrushSize;
                uniform float uTime;
                varying vec2 vUv;

                // Pseudo-random
                float rand(vec2 co){
                    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
                }

                void main() {
                    vec4 prev = texture2D(uPrev, vUv);
                    float h = prev.r;
                    
                    // Diffusion/Settling - sand spreads to neighbors
                    float texelSize = 1.0 / 512.0;
                    float n = texture2D(uPrev, vUv + vec2(0.0, texelSize)).r;
                    float s = texture2D(uPrev, vUv + vec2(0.0, -texelSize)).r;
                    float e = texture2D(uPrev, vUv + vec2(texelSize, 0.0)).r;
                    float w = texture2D(uPrev, vUv + vec2(-texelSize, 0.0)).r;
                    
                    // Cellular automata-like settling
                    float avgNeighbor = (n + s + e + w) * 0.25;
                    float diff = avgNeighbor - h;
                    
                    // If neighbors are higher, sand flows in (sedimentation)
                    if (diff > 0.02) {
                        h += diff * 0.15;
                    }
                    
                    // Natural Decay (Memory Sand) - very slow
                    h *= 0.9995;

                    // Height Clamping per Region
                    // Base height constraint from local noise
                    float baseNoise = rand(floor(vUv * 8.0) / 8.0);
                    float minH = 0.0;
                    float maxH = 0.3 + baseNoise * 0.4; // Varies per region
                    
                    h = clamp(h, minH, maxH);

                    // Draw Snake
                    if (uSnakeUV.x >= 0.0 && uSnakeUV.x <= 1.0) {
                        float dist = distance(vUv, uSnakeUV);
                        if (dist < uBrushSize) {
                            // Multi-scale brush for particle detail
                            float intensity = smoothstep(uBrushSize, uBrushSize * 0.3, dist);
                            
                            // High-freq particle noise
                            float particleNoise = rand(vUv * 200.0 + uTime * 0.1);
                            float mediumNoise = rand(vUv * 50.0 + uTime * 0.05);
                            
                            // Layered disturbance
                            float disturbance = intensity * (0.5 + 0.3 * mediumNoise + 0.2 * particleNoise);
                            
                            h = max(h, disturbance);
                        }
                    }
                    
                    gl_FragColor = vec4(h, 0.0, 0.0, 1.0);
                }
            `
        });

        const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.simMaterial);
        this.simScene.add(plane);

        // Combined Uniforms (Sand Physics + Tides)
        this.sandUniforms = {
            uSandMap: { value: null }, // RTT Texture
            uTime: { value: 0 },
            uGlobalScale: { value: 1.0 },
            // Tides / Ripples - References will be copied from Game
            uRippleCenters: { value: new Array(5).fill().map(() => new THREE.Vector3()) },
            uRippleStartTimes: { value: new Array(5).fill(-1000) },
            uRippleIntensities: { value: new Array(5).fill(0) },
            uEarthRadius: { value: 10.0 }
        };
    }

    setRippleUniforms(rippleUniforms) {
        // Link our uniforms to the game's ripple uniforms for synchronization
        this.sandUniforms.uRippleCenters = rippleUniforms.uRippleCenters;
        this.sandUniforms.uRippleStartTimes = rippleUniforms.uRippleStartTimes;
        this.sandUniforms.uRippleIntensities = rippleUniforms.uRippleIntensities;
        this.sandUniforms.uTime = rippleUniforms.uTime;
    }

    trigger(earthRadius) {
        if (this.state !== 'inactive') return;
        
        // 1. Determine Location
        const u = Math.random();
        const v = Math.random();
        const theta = 2 * Math.PI * u;
        const phi = Math.acos(2 * v - 1);
        
        this.center.set(
            Math.sin(phi) * Math.cos(theta),
            Math.sin(phi) * Math.sin(theta),
            Math.cos(phi)
        ).normalize();
        
        // 2. Generate Proper Mesh
        // Always generate at base radius; we handle growth via scaling
        this.createMesh(this.baseRadius);
        
        // 3. Start Animation
        this.state = 'spawning';
        this.progress = 0;
        this.mesh.visible = true;
    }

    createMesh(radius) {
        if (this.mesh) {
            this.scene.remove(this.mesh);
            if(this.mesh.geometry) this.mesh.geometry.dispose();
            if(this.mesh.material) this.mesh.material.dispose();
        }

        // Generate the detailed terrain mesh
        this.mesh = createIslandMesh(radius);
        
        // Inject Sand Physics Shader
        this.mesh.material.onBeforeCompile = (shader) => {
            // Bind Texture
            shader.uniforms.uSandMap = this.sandUniforms.uSandMap;
            shader.uniforms.uGlobalScale = this.sandUniforms.uGlobalScale;
            
            shader.uniforms.uTime = this.sandUniforms.uTime;
            shader.uniforms.uRippleCenters = this.sandUniforms.uRippleCenters;
            shader.uniforms.uRippleStartTimes = this.sandUniforms.uRippleStartTimes;
            shader.uniforms.uRippleIntensities = this.sandUniforms.uRippleIntensities;

            // --- VERTEX SHADER ---
            shader.vertexShader = `
                uniform sampler2D uSandMap;
                uniform float uGlobalScale;
                varying vec3 vWorldPos;
                varying float vIsBeach;
                varying vec2 vSandUV;
            ` + shader.vertexShader;

            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                `
                #include <begin_vertex>
                
                vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
                vWorldPos = worldPosition.xyz;

                vIsBeach = 0.0;
                #ifdef USE_COLOR
                    if (color.r > 0.6 && color.g > 0.5) {
                        vIsBeach = 1.0;
                    }
                #endif

                // Calculate UV for Sand Map (Planar projection from Top-Down local space)
                // Island is constructed around Y axis. 
                // We need local position relative to island origin, unscaled.
                // Since 'transformed' is already in local space, we use that.
                // Map range: +/- BaseRadius * 1.2 to 0..1
                float mapRange = 10.0 * 1.2; // BaseRadius 10
                vSandUV = (transformed.xz / mapRange) * 0.5 + 0.5;

                if (vIsBeach > 0.5) {
                    float sandH = texture2D(uSandMap, vSandUV).r;
                    // Displace downwards (trench)
                    // Scale depth by global scale
                    float depth = sandH * 0.3 * uGlobalScale;
                    
                    // Apply displacement along normal (inwards)
                    transformed -= normal * depth;
                    
                    // Also slight ridge on sides? 
                    // Let's keep it simple: just a nice track
                }
                `
            );
            
            // --- FRAGMENT SHADER ---
            const fragHead = `
                uniform float uTime;
                uniform sampler2D uSandMap;
                uniform vec3 uRippleCenters[5];
                uniform float uRippleStartTimes[5];
                uniform float uRippleIntensities[5];
                varying vec3 vWorldPos;
                varying float vIsBeach;
                varying vec2 vSandUV;
                
                float rand(vec2 co){
                    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
                }

                // Simple 3D noise for sparkles
                float noise3D(vec3 p) {
                    return fract(sin(dot(p, vec3(12.9898, 78.233, 54.53))) * 43758.5453);
                }

                float getRippleAt(vec3 pos) {
                    float total = 0.0;
                    vec3 pNorm = normalize(pos);
                    for(int i=0; i<5; i++) {
                        float startTime = uRippleStartTimes[i];
                        if (startTime < 0.0) continue;
                        float age = uTime - startTime;
                        if (age < 0.0 || age > 2.0) continue;
                        vec3 center = uRippleCenters[i];
                        float intensity = uRippleIntensities[i];
                        float dotProd = dot(pNorm, normalize(center));
                        float angle = acos(clamp(dotProd, -1.0, 1.0));
                        float dist = angle * 10.0;
                        float speed = 8.0; 
                        float waveCenter = age * speed;
                        float distDiff = dist - waveCenter;
                        if (abs(distDiff) < 2.0) {
                            float ripple = sin(distDiff * 3.0) * exp(-distDiff * distDiff);
                            ripple *= (1.0 - age / 2.0);
                            ripple *= intensity;
                            total += ripple;
                        }
                    }
                    return total;
                }
            `;

            shader.fragmentShader = fragHead + shader.fragmentShader;
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <dithering_fragment>',
                `#include <dithering_fragment>
                
                if (vIsBeach > 0.5) {
                    // 1. Ripple / Wet Sand
                    float rVal = getRippleAt(vWorldPos);
                    if (abs(rVal) > 0.05) {
                        float wet = smoothstep(0.05, 0.3, abs(rVal));
                        vec3 wetColor = gl_FragColor.rgb * 0.6 + vec3(0.1, 0.2, 0.3) * 0.2;
                        gl_FragColor.rgb = mix(gl_FragColor.rgb, wetColor, wet * 0.8);
                        // Make wet sand glossier
                        if (wet > 0.5) {
                           // Simple specular approx
                           gl_FragColor.rgb += vec3(0.1) * wet;
                        }
                    }
                    
                    // 2. Sand Detail (Particle Wise)
                    // Multi-scale grain for realism
                    float grain1 = rand(vSandUV * 400.0);
                    float grain2 = rand(vSandUV * 150.0);
                    float grain3 = rand(vSandUV * 50.0);
                    float combinedGrain = grain1 * 0.5 + grain2 * 0.3 + grain3 * 0.2;
                    
                    gl_FragColor.rgb *= (0.92 + 0.16 * combinedGrain);
                    
                    // Sparkles (Sun glint on individual grains)
                    float sparkleNoise = rand(vWorldPos.xy * 100.0 + vWorldPos.z * 100.0 + uTime * 0.05);
                    float sparkle = smoothstep(0.985, 1.0, sparkleNoise);
                    gl_FragColor.rgb += vec3(0.2, 0.18, 0.15) * sparkle;

                    // 3. Snake Trail (Sediment / Disturbance)
                    float track = texture2D(uSandMap, vSandUV).r;
                    if (track > 0.01) {
                        // Deeper depression shows darker base sand
                        float depression = smoothstep(0.0, 0.5, track);
                        gl_FragColor.rgb *= (1.0 - depression * 0.35);
                        
                        // Particle displacement at edges (pushed up sand)
                        // Sample gradient to find edges
                        float texelSize = 1.0 / 512.0;
                        float trackN = texture2D(uSandMap, vSandUV + vec2(0.0, texelSize)).r;
                        float trackS = texture2D(uSandMap, vSandUV - vec2(0.0, texelSize)).r;
                        float trackE = texture2D(uSandMap, vSandUV + vec2(texelSize, 0.0)).r;
                        float trackW = texture2D(uSandMap, vSandUV - vec2(texelSize, 0.0)).r;
                        
                        float gradient = abs(trackN - trackS) + abs(trackE - trackW);
                        float edge = smoothstep(0.1, 0.3, gradient);
                        
                        // Brighter at edges (piled sand)
                        gl_FragColor.rgb += vec3(0.08, 0.07, 0.05) * edge;
                        
                        // Granular detail in disturbed areas
                        float disturbedGrain = rand(vSandUV * 300.0 + track);
                        gl_FragColor.rgb += vec3(0.04) * track * disturbedGrain;
                    }
                }`
            );
        };

        // Align mesh to the target center
        // The mesh is generated at North Pole (0, 1, 0)
        // We rotate it to align (0, 1, 0) with this.center
        const alignQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.center);
        this.mesh.quaternion.copy(alignQ);
        
        // Initially scale down for spawn effect
        this.mesh.scale.set(0.1, 0.1, 0.1);
        
        this.scene.add(this.mesh);
    }

    // Get height at a specific direction (normalized) relative to sphere center
    getHeightAndNormal(direction, earthRadius) {
        if ((this.state !== 'docked' && this.state !== 'spawning') || !this.mesh) return { height: 0, normal: direction.clone() };

        // Scale Factor (Earth has grown, island grows with it)
        const scale = earthRadius / this.baseRadius;

        // 1. Transform world direction into Island Local Space (where island is at North Pole)
        const invQ = this.mesh.quaternion.clone().invert();
        const localDir = direction.clone().applyQuaternion(invQ); // Should be near (0, 1, 0)

        // Fix ghost island on opposite side:
        // Projecting sphere surface to XZ plane (used in calculateIslandHeight) is ambiguous for poles (both 0,0).
        // We restrict island influence to the top hemisphere (localDir.y > threshold).
        // Island radius is ~72 deg => cos(72) ~ 0.3. We use 0.2 as a safe cutoff to ignore the antipode.
        if (localDir.y < 0.2) return { height: 0, normal: direction.clone() };
        
        // 2. Calculate coordinates on the BASE sphere
        // localDir is normalized. We map it to the BASE radius to check noise consistency
        const px = localDir.x * this.baseRadius;
        const py = localDir.y * this.baseRadius;
        const pz = localDir.z * this.baseRadius;
        
        // 3. Get Base Height
        const hBase = calculateIslandHeight(px, py, pz, this.baseRadius);
        
        if (hBase <= 0.001) return { height: 0, normal: direction.clone() };
        
        // 4. Calculate Normal (Finite Difference approximation in Base Space)
        const eps = 0.1;
        const hx = calculateIslandHeight(px + eps, py, pz, this.baseRadius);
        const hz = calculateIslandHeight(px, py, pz + eps, this.baseRadius);
        
        // Slopes
        const dhdx = (hx - hBase) / eps;
        const dhdz = (hz - hBase) / eps;
        
        const localNormal = new THREE.Vector3(-dhdx, 1, -dhdz).normalize();
        
        // 5. Transform normal back to world space
        const worldNormal = localNormal.applyQuaternion(this.mesh.quaternion);

        // 6. Calculate Final Height
        // Scale the base height directly.
        // We clamp to 0 to ensure snake stays on water surface when over the underwater skirt,
        // effectively treating the ocean as a solid floor at height 0.
        const hPhysical = Math.max(0, hBase * scale);

        return { height: hPhysical, normal: worldNormal };
    }

    update(dt, earthRadius, snake, renderer) {
        if (this.state === 'inactive') return;
        
        const globalScale = earthRadius / this.baseRadius;
        this.sandUniforms.uGlobalScale.value = globalScale;

        // --- Simulate Sand (RTT) ---
        if (renderer && snake && this.mesh) {
            // Calculate Snake UV
            // 1. Get Snake Pos in Island Local Space
            const invQ = this.mesh.quaternion.clone().invert();
            // We need position relative to Earth center, but rotated to align with Island local Y
            // But we also need to account for scale.
            // Local Space unscaled = (WorldPos applied with invQ) / Scale
            
            const localPos = snake.head.position.clone().applyQuaternion(invQ).divideScalar(globalScale);
            
            // 2. Map XZ to UV
            // Range +/- 12 (Base 10 * 1.2)
            const mapRange = 10.0 * 1.2;
            const u = (localPos.x / mapRange) * 0.5 + 0.5;
            const v = (localPos.z / mapRange) * 0.5 + 0.5;
            
            this.simMaterial.uniforms.uSnakeUV.value.set(u, v);
            this.simMaterial.uniforms.uPrev.value = this.prevRt.texture;
            this.simMaterial.uniforms.uTime.value += dt;
            
            // Render Step
            renderer.setRenderTarget(this.currentRt);
            renderer.render(this.simScene, this.simCamera);
            renderer.setRenderTarget(null); // Reset
            
            // Swap Buffers
            const temp = this.currentRt;
            this.currentRt = this.prevRt;
            this.prevRt = temp;
            
            // Bind result to Island
            this.sandUniforms.uSandMap.value = this.prevRt.texture;
        }

        if (this.state === 'docked') {
             if (this.mesh) {
                 this.mesh.scale.setScalar(globalScale);
             }
             return;
        }
        
        this.progress += dt * 0.3; // Rise over ~3 seconds
        
        if (this.progress >= 1.0) {
            this.progress = 1.0;
            this.state = 'docked';
            this.mesh.scale.setScalar(globalScale);
        } else {
            // Animation: "Breach" effect
            const p = this.progress;
            const animScale = THREE.MathUtils.smoothstep(p, 0, 1);
            
            // Combined Scale: Earth Growth * Spawning Animation
            this.mesh.scale.setScalar(globalScale * animScale);
        }
    }
}