import { useEffect, useState } from 'react';
import { api } from '../api';

export function Menu() {
  const [items, setItems] = useState([]);
  useEffect(() => { api.get('/menu').then(setItems); }, []);
  return <ul>{items.map(i => <li key={i.id}>{i.name}: ${i.price}</li>)}</ul>;
}
