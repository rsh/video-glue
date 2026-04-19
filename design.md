clone


this is going to be a website called video-glue internally scans a directory for new video files, and if it finds one, processes it in the following way:
  1. scans it and grabs metadata: filename, file size, date modified. adds those to a database, then puts it
  in a queue for processing. processing entails: finding every scene transition and segmenting the movie into a series of segments that account for every frame. we want the ability to cut a gif of exactly the two scenes we want, if its a hard cut, it should be frame accurate by default.

  "hard-cut": where there are two consecutive frames where it is clear a new scene or camera angle has started

  the website has a sqlite database. figure out a way to store the hard cut information such that i can run a different scanner later and it can be a different thing, like "funny scene". hard cuts are stored as a series of segments, where every frame is accounted for.

  make a web ui that allows users to find segments and stick them together. it looks like a simple video editor. you drag segments from a grid of them into the bottom half that has the video editing timeline. it only has one track. segments can be trimmed. there are no transitions.

you can save a set of segments and trimmings information. it has a default name of randomly generated words, but you can rename it.

it allows you to export your set of segments as a webm, gif, or other high quality short video. mp4, even. probably use ffmpeg for that internally.
