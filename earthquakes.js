/* global Rx, THREE, data */
const OrbitControls = createOrbitControls(THREE)

var earthRadius = 0.5
var coneHeight = 0.15
var playTime = 10000

var startState = {
  playing: false,
  currentTime: playTime,
  totalTime: playTime
}

var playState$ = new Rx.BehaviorSubject(Object.assign({}, startState))

// Used to know how much time has passed in tick.
var lastFrameTime = null
// Used to cancel animation frame callbacks.
var requestID = null

// React to changes in state.
playState$.subscribe((playState) => {
  // Cancel the previous callback if it hasn't fired yet.
  if (requestID) {
    window.cancelAnimationFrame(requestID)
    requestID = null
  }
  // If playing, request animation frame to run tick.
  if (playState.playing) {
    // Save current time so we know how much time passed before tick.
    lastFrameTime = Date.now()
    requestID = window.requestAnimationFrame(tick)
  }
})

// Helper to merge values.
var updatePlayState = newState => {
  playState$.onNext(Object.assign(playState$.getValue(), newState))
}

// Callback for updating play state and time.
var tick = () => {
  // Request has been called so no need to keep ID.
  requestID = null

  var state = playState$.getValue()

  // New time is old time + time since last frame (or totalTime)
  var currentTime = Math.min(
    state.currentTime + Date.now() - lastFrameTime,
    state.totalTime
  )

  updatePlayState({
    // Stop playing if we have reached the end.
    playing: currentTime >= state.totalTime ? false : true,
    currentTime: currentTime
  })
}

var play = () => {
  var state = playState$.getValue()
  updatePlayState({
    playing: true,
    // Rewind if at end.
    currentTime: state.currentTime === state.totalTime ? 0 : state.currentTime
  })
}

var pause = () => {
  updatePlayState({playing: false})
}

// Features from GeoJSON Summary Format.
// http://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php
var features$ = new Rx.ReplaySubject(1)
// JSONP callback.
function eqfeed_callback(data) {
  features$.onNext(data.features)
}

var renderTime$ = Rx.Observable.combineLatest(
  features$, playState$,
  (features, playState) => {
    var first = features[features.length - 1].properties.time
    var last = features[0].properties.time
    var total = features[0].properties.time - features[features.length - 1].properties.time
    return first + playState.currentTime * total / playTime
  }
)

// Play button.
var button = document.getElementById('button')
// Toggle play/pause.
button.addEventListener('click', () =>
  playState$.getValue().playing ?
    pause() :
    play()
)
// Update button text.
playState$.subscribe((playState) => button.value = playState.playing ? 'Pause' : 'Play')

// Time slider. Value is between 0 and 1.
var slider = document.getElementById('slider')
// Pause on mousedown.
slider.addEventListener('mousedown', pause)
// Update playState on input.
slider.addEventListener('input', (e) => {
  updatePlayState({
    playing: false,
    currentTime: e.target.value * playTime
  })
})
// Update slider value.
playState$.subscribe((playState) => {
  slider.value = playState.currentTime / playState.totalTime
})

// Display time.
var date = document.getElementById('date')
// Update text.
renderTime$.subscribe(t => {
  date.innerText = new Date(t).toLocaleString()
})

// Get canvas dimensions from canvas-wrapper.
var canvasWrapper = document.getElementById('canvas-wrapper')
var dimensions$ = new Rx.ReplaySubject(1)
var updateDimensions = () =>
  dimensions$.onNext({
    width: canvasWrapper.clientWidth,
    height: canvasWrapper.clientHeight
  })
window.addEventListener('load', updateDimensions)
window.addEventListener('resize', updateDimensions)

// Renderer
var canvas = document.getElementById('canvas')
// Keep renderer dimensions up to date.
var renderer$ = dimensions$.scan((renderer, d) => {
  renderer.setSize(d.width, d.height)
  return renderer
}, new THREE.WebGLRenderer({canvas: canvas}))

// Camera
// Create observable manually so we can trigger updates based on
// dimensions and camera controls.
var camera$ = Rx.Observable.create(observer => {
  var camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
  camera.position.x = 1.5
  camera.position.y = 1
  camera.position.z = -1

  var cameraControls = new OrbitControls(camera, canvas)
  cameraControls.target.set(0, 0, 0)

  var onNext = observer.onNext.bind(observer, camera)

  // Update when dimensions change.
  dimensions$.subscribe(d => {
    camera.aspect = d.width/d.height
    camera.updateProjectionMatrix()
    onNext()
  })

  // Update when camera controls are used.
  cameraControls.addEventListener('change', onNext)

  onNext()
})

// Create observable THREE object that updates observable children.
function objectWithChildren(object, children) {
  // Make sure all children are observables.
  children = children.map(c =>
    typeof c.subscribe === 'function' ?
      c :
      Rx.Observable.just(c)
  )
  return Rx.Observable
    .combineLatest(children)
    .scan((o, c) => {
      o.remove.apply(o, o.children)
      o.add.apply(o, c)
      return o
    }, object)
}

// Location in sky is adjusted according to time.
var sun$ = renderTime$.scan((sun, t) => {
  var d = new Date(t)
  // +6 is to adjust it to correct place in sky
  var rad = (d.getUTCHours() + 6 + d.getMinutes() / 60) / 24 * 2 * Math.PI
  sun.position.set(10 * Math.sin(rad), 0, 10 * Math.cos(rad))
  return sun
}, Object.assign(new THREE.SpotLight(0xffffff, 0.8), {decay: 0}))

// Load texture as observable.
THREE.ImageUtils.crossOrigin = ''
function loadTexture$(url) {
  return Rx.Observable.create((observer) => {
    new THREE.TextureLoader().load(url,
      img => { observer.onNext(img); observer.onCompleted() },
      () => {},
      xhr => { observer.onError(xhr) }
    )
  })
}

var earth$ = Rx.Observable
  .combineLatest(
    ['images/earthmap1k.jpg', 'images/earthbump1k.jpg', 'images/earthspec1k.jpg'].map(loadTexture$)
  )
  .map(textures => {
    // Set texture filters to avoid console warning.
    textures.forEach(t => t.minFilter = THREE.NearestFilter)

    var geometry = new THREE.SphereGeometry(earthRadius, 32, 32)
    // Rotate 180 to match lat lon calcs later
    geometry.rotateY(Math.PI)

    var material = new THREE.MeshPhongMaterial({
      map: textures[0],
      bumpMap: textures[1],
      bumpScale: 0.05,
      specularMap: textures[2],
      specular: new THREE.Color('grey'),
      shininess: 10
    })

    return new THREE.Mesh(geometry, material)
})

var featureGroup$ = features$.flatMapLatest(features => {
  var lastTime = features[0].properties.time
  var group = new THREE.Group()
  group.add.apply(group, features.map(createFeature))

  // Update opacity when time changes.
  return renderTime$.scan((group, renderTime) => {
    for (var i = 0; i < group.children.length; i++) {
      // If renderTime is at end, show all features.
      group.children[i].material.opacity = renderTime >= lastTime ?
        1 :
        featureOpacity(renderTime, features[i].properties.time)
    }
    return group
  }, group)
})

function featureOpacity(renderTime, featureTime) {
  return renderTime < featureTime ?
    // Hide features that haven't happened yet
    0 :
    // Otherwise fade feature over 6 hours
    Math.max(0.2, 1 - ((renderTime - featureTime) / (6 * 60 * 60 * 1000)))
}

function createFeature(feature) {
  var magnitude = feature.properties.mag
  var height = coneHeight * Math.max(magnitude / 10, 0.1)
  // radiusTop, radiusBottom, height, radiusSegments
  var coneGeometry = new THREE.CylinderGeometry(height / 5, 0.001, height, 16)
  // Make point the center.
  coneGeometry.translate(0, height / 2, 0)
  // Rotate so lookAt points as expected.
  coneGeometry.rotateX( -Math.PI / 2 )
  var coneMaterial = new THREE.MeshBasicMaterial({
    color: "hsl(" + (100 - (magnitude * 10)) + ", 100%, 50%)"
  })
  coneMaterial.transparent = true
  coneMaterial.opacity = 1
  var cone = new THREE.Mesh(
    coneGeometry,
    coneMaterial
  )
  // Convert lat/lon to xyz.
  var lat = feature.geometry.coordinates[1] * Math.PI / 180
  var lon = feature.geometry.coordinates[0] * Math.PI / 180
  cone.position.set(
    -earthRadius * Math.cos(lat) * Math.cos(lon),
    earthRadius * Math.sin(lat),
    earthRadius * Math.cos(lat) * Math.sin(lon)
  )
  // Point back at center.
  cone.lookAt(new THREE.Vector3(0, 0, 0))

  return cone
}

var scene$ = objectWithChildren(new THREE.Scene(), [
  new THREE.AmbientLight(0xffffff, 0.4),
  sun$,
  earth$,
  featureGroup$
])

// Render on change.
Rx.Observable
  .combineLatest(renderer$, scene$, camera$)
  .subscribe(([renderer, scene, camera]) => {
    renderer.render(scene, camera)
  })
