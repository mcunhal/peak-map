<template>
  <div class='about'>
    <div class='background absolute' @click.prevent='close'></div>
    <div class='content'>
      <h3>Peak map <a class='close bold' href='#' @click.prevent='close'>close</a></h3>
      <p>
        Pick any region on Earth and turn its terrain into line art built for pen plotting:
        layered SVG in millimetres, GPX routes on their own pens, and a choice of algorithms
        for turning elevation into lines.
      </p>

      <p>
        This is a fork of <a href='https://github.com/anvaka/peak-map' class='highlighted'>peak-map</a>
        by Anvaka, whose hidden-line ridgeline renderer it is still built around.
        Elevation data comes from
        <a href='https://registry.opendata.aws/terrain-tiles/' class='highlighted'>AWS Terrain Tiles</a>,
        so the app needs no API key.
      </p>
      <a href='#' @click.prevent='close' class='large-close bold'>
        close
      </a>
    </div>
  </div>
</template>
<script>
export default {
  mounted() {
    this.closeHandler = (e) => {
      if (e.keyCode === 27) {
        e.preventDefault();
        this.close();
      }
    }
    document.addEventListener('keyup', this.closeHandler);
  },
  beforeDestroy() {
    document.removeEventListener('keyup', this.closeHandler);
  },
  methods: {
    close() {
      this.$emit('close');
    }
  }
}
</script>

<style lang='stylus'>
.about {
  z-index: 4;
  position: fixed;
  overflow-y: auto;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  .close {
    position: absolute;
    right: 15px;
    font-size: 12px;
  }
  .large-close {
    width: 100%;
    height: 32px;
    display: block;
    text-align: center;
  }
  .content {
    position: absolute;
    background-color: #fff;
    width: 400px;
    padding: 14px;
    h3 {
      margin: 0;
      font-weight: normal;
    }
  }
}
.background {
  position: absolute;
  background-color: rgba(99, 99, 99, 0.8);
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
}
@media (max-width: 800px) {
  .about {
    justify-content: initial;
  }
  .about .content {
    width: 100%;
    border: none;
  }
}
</style>
