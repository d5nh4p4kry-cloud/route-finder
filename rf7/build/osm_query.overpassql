[out:json][timeout:180][bbox:35.38,139.30,35.68,139.76];
(
  way[highway~"^(motorway|motorway_link)$"];
  way[highway~"^(trunk|trunk_link)$"][motorroad=yes];
  way[highway~"^(trunk|trunk_link)$"][toll=yes];
)->.hw;
.hw out body geom;
node(w.hw)->.hn;
node.hn[highway=motorway_junction]; out body;
node.hn[barrier=toll_booth]; out body;
way(bn.hn)[highway]->.touch;
(.touch; - .hw;)->.sw;
.sw out body;
rel(bw.hw)[type=restriction]; out body;
