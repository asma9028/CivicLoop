import { MapContainer, Marker, TileLayer, useMapEvents } from 'react-leaflet';
import L from 'leaflet';

const selectedMarker = L.divIcon({
  className: 'selected-location-marker',
  html: '<div></div>',
  iconSize: [28, 28],
  iconAnchor: [14, 28],
});

function MapClick({ onSelect }: { onSelect: (latitude: number, longitude: number) => void }) {
  useMapEvents({
    click(event) {
      onSelect(event.latlng.lat, event.latlng.lng);
    },
  });
  return null;
}

export function LocationPicker({ latitude, longitude, onSelect }: {
  latitude: number;
  longitude: number;
  onSelect: (latitude: number, longitude: number) => void;
}) {
  return (
    <MapContainer center={[latitude, longitude]} zoom={13} className="location-picker-map" scrollWheelZoom>
      <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <MapClick onSelect={onSelect} />
      <Marker
        position={[latitude, longitude]}
        icon={selectedMarker}
        draggable
        eventHandlers={{ dragend: (event) => {
          const point = event.target.getLatLng();
          onSelect(point.lat, point.lng);
        } }}
      />
    </MapContainer>
  );
}
