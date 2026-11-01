[out:json][timeout:120];
(
  way[highway~"^(service|motorway_link)$"](around:600,35.4903416,139.368994);
  way[highway~"^(service|motorway_link)$"](around:600,35.4918128,139.369453);
  way[highway~"^(service|motorway_link)$"](around:600,35.5357472,139.5332665);
  way[highway~"^(service|motorway_link)$"](around:600,35.5327154,139.5269309);
  way[highway~"^(service|motorway_link)$"](around:600,35.4316273,139.4005378);
  way[highway~"^(service|motorway_link)$"](around:600,35.4316047,139.3996791);
)->.w;
.w out body geom;
